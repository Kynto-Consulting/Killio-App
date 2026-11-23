import type { MessageResponse, SseEvent, StopReason } from '../src/api.ts'
import type { AgentEvent } from '../src/wire.ts'
import { type AssemblerOptions, MessageAssembler } from '../src/assembler.ts'
import { ApiError, type ApiError as ApiErrorType, errorBody, upstreamError } from '../src/errors.ts'
import { encodeSse } from '../src/sse.ts'

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' }
const PING_MS = 15_000

// One HTTP response for one client message. Starts lazily on the first engine event,
// so an upstream failure before any output can still be a plain HTTP error.
export class ResponseSink {
  readonly response: Promise<Response>
  private resolve: (res: Response) => void = () => {}
  private readonly assembler: MessageAssembler
  private readonly stream: boolean
  private readonly onEnd: (sink: ResponseSink) => void
  private readonly encoder = new TextEncoder()
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined
  private ping: ReturnType<typeof setInterval> | undefined
  private started = false
  private ended = false

  constructor(opts: AssemblerOptions, stream: boolean, onEnd: (sink: ResponseSink) => void) {
    this.stream = stream
    this.onEnd = onEnd
    this.response = new Promise(resolve => {
      this.resolve = resolve
    })
    this.assembler = new MessageAssembler(opts, ev => this.write(ev))
  }

  get isEnded(): boolean {
    return this.ended
  }

  get stopReason(): StopReason | null {
    return this.assembler.message().stop_reason
  }

  get clientToolUseIds(): readonly string[] {
    return this.assembler.clientToolUseIds
  }

  message(): MessageResponse {
    return this.assembler.message()
  }

  feed(ev: AgentEvent): void {
    if (this.ended) return
    if (ev.kind === 'turn-end' && (ev.reason === 'error' || ev.reason === 'aborted' || ev.upstreamFailure !== undefined)) {
      const failure = ev.kind === 'turn-end' ? ev.upstreamFailure : undefined
      if (failure) {
        const type = failure.status === 400 ? 'invalid_request_error'
          : failure.status === 401 ? 'authentication_error'
            : failure.status === 403 ? 'permission_error'
              : failure.status === 404 ? 'not_found_error'
                : failure.status === 429 ? 'rate_limit_error'
                  : failure.status === 529 ? 'overloaded_error'
                    : 'api_error'
        this.fail(new ApiError(failure.status, type, `Claude Code upstream error: ${failure.message}`))
      } else this.fail(upstreamError(ev.reason === 'aborted' ? 'aborted' : 'error'))
      return
    }
    this.ensureStarted()
    switch (ev.kind) {
      case 'text':
        this.assembler.text(ev.index, ev.text)
        break
      case 'thinking':
        this.assembler.thinking(ev.index, ev.text)
        break
      case 'compaction':
        this.assembler.compaction(ev.content)
        break
      case 'compaction-pause':
        this.assembler.pauseAfterCompaction()
        break
      case 'usage-iterations':
        this.assembler.usageIterations(ev.iterations)
        break
      case 'tool':
        this.assembler.tool(ev.index, ev.id, ev.name)
        break
      case 'input':
        this.assembler.input(ev.index, ev.json)
        break
      case 'step-end':
        this.assembler.stepEnd({ stopReason: ev.stopReason, usage: ev.usage, toolUseIds: ev.toolUseIds })
        break
      case 'turn-end':
        this.assembler.finish(ev.reason === 'refusal' ? 'refusal' : 'end_turn')
        break
    }
    if (this.assembler.isFinished) this.end()
  }

  fail(err: ApiErrorType): void {
    if (this.ended) return
    if (!this.started || !this.stream) {
      this.ended = true
      this.stopPing()
      this.resolve(Response.json(errorBody(err), { status: err.status }))
      this.onEnd(this)
      return
    }
    this.assembler.fail(err.type, err.message)
    this.end()
  }

  abandon(): void {
    if (this.ended) return
    this.ended = true
    this.stopPing()
    try {
      this.controller?.close()
    } catch {}
    this.onEnd(this)
  }

  private ensureStarted(): void {
    if (this.started) return
    this.started = true
    if (this.stream) {
      const body = new ReadableStream<Uint8Array>({
        start: controller => {
          this.controller = controller
        },
      })
      this.resolve(new Response(body, { headers: SSE_HEADERS }))
      this.ping = setInterval(() => this.write({ type: 'ping' }), PING_MS)
    }
    this.assembler.start()
  }

  private write(ev: SseEvent): void {
    if (!this.stream || !this.controller) return
    try {
      this.controller.enqueue(this.encoder.encode(encodeSse(ev)))
    } catch {}
  }

  private end(): void {
    if (this.ended) return
    this.ended = true
    this.stopPing()
    if (this.stream) {
      try {
        this.controller?.close()
      } catch {}
    } else this.resolve(Response.json(this.assembler.message()))
    this.onEnd(this)
  }

  private stopPing(): void {
    if (this.ping !== undefined) clearInterval(this.ping)
    this.ping = undefined
  }
}
