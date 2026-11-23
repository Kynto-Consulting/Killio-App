// Each ccapi request runs in its own headless Claude Code CLI session. The bridge owns the
// HTTP listener; this hook connects a worker session to that bridge and forwards model events.
import type { EngineInterface, Register } from 'claude-code'
import type { AgentEvent, EngineToolResult, EngineUsage } from '../src/wire.ts'
import { OrderedSender } from '../src/event-sender.ts'
import { ATTACHMENTS_TOOL, TOOL_PREFIX } from '../src/tool-names.ts'

type Runtime = {
  base: string
  headers: Record<string, string>
  convId: string
  agentId: string
  sender: OrderedSender<AgentEvent>
  toolWaitMs: number
  streamedText: string
  pendingStepEnd?: Extract<AgentEvent, { kind: 'step-end' }>
}

let runtime: Runtime | undefined

const post = async ($: EngineInterface, r: Runtime, path: string, body: unknown): Promise<void> => {
  const response = await $.http.fetch(`${r.base}${path}`, { method: 'POST', headers: r.headers, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`ccapi bridge ${path} answered ${response.status}`)
}

const toEngineUsage = (usage: EngineUsage | null): EngineUsage | null => usage === null ? null : ({
  input_tokens: usage.input_tokens,
  output_tokens: usage.output_tokens,
  cache_read_input_tokens: usage.cache_read_input_tokens,
  cache_creation_input_tokens: usage.cache_creation_input_tokens,
})

export const register: Register = on => {
  on('session.start', async ($, event, next) => {
    const started = await next(event)
    if ((await $.env.get('CCAPI_WORKER')) !== '1') return started
    const port = (await $.env.get('CCAPI_PORT')) ?? '18787'
    const internalToken = await $.env.get('CCAPI_INTERNAL_TOKEN')
    const convId = await $.env.get('CCAPI_WORKER_CONV_ID')
    const agentId = (await $.env.get('CCAPI_WORKER_AGENT_ID')) || convId!
    if (!internalToken || !convId) throw new Error('ccapi worker is missing its bridge credentials')

    const worker: Runtime = {
      base: `http://127.0.0.1:${port}`,
      headers: { 'x-ccapi-internal': internalToken, 'content-type': 'application/json' },
      convId,
      agentId,
      sender: new OrderedSender<AgentEvent>(
        batch => post($, worker, '/internal/events', batch),
        error => $.ui.log(`ccapi event delivery failed: ${String(error)}`, { to: 'debug' }),
        { retries: 4, sleep: ms => $.clock.sleep(ms) },
      ),
      toolWaitMs: Number((await $.env.get('CCAPI_TOOL_WAIT_MINUTES')) ?? '10') * 60_000,
      streamedText: '',
    }
    runtime = worker

    const response = await $.http.fetch(`${worker.base}/internal/worker-config/${convId}`, { headers: worker.headers })
    if (!response.ok) throw new Error(`ccapi worker config returned ${response.status}`)
    const config = JSON.parse(response.text) as {
      attachments: boolean
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
    }
    if (config.attachments) await $.tool.register({
      name: ATTACHMENTS_TOOL,
      description: 'Shows the images and documents attached to this conversation. Pass ids to see specific attachments; omit them to see all.',
      inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } } } },
    })
    for (const tool of config.tools)
      await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
    return started
  })

  on('turn.step', async function* ($, event, next) {
    const worker = runtime
    if (!worker) return yield* next(event)
    const stream = next(event)
    const tools: Array<{ id: string; name: string }> = []
    let stopReason: string | null = null
    let usage: EngineUsage | null = null
    for await (const chunk of stream) {
      if (chunk.kind === 'text') {
        worker.streamedText += chunk.text
        worker.sender.push({ kind: 'text', agentId: worker.agentId, index: chunk.index, text: chunk.text })
      } else if (chunk.kind === 'thinking') {
        worker.sender.push({ kind: 'thinking', agentId: worker.agentId, index: chunk.index, text: chunk.text })
      } else if (chunk.kind === 'tool') {
        tools.push({ id: chunk.id, name: chunk.name })
        worker.sender.push({ kind: 'tool', agentId: worker.agentId, index: chunk.index, id: chunk.id, name: chunk.name })
      } else if (chunk.kind === 'input') {
        worker.sender.push({ kind: 'input', agentId: worker.agentId, index: chunk.index, json: chunk.json })
      } else if (chunk.kind === 'stop') {
        stopReason = chunk.stopReason
        usage = chunk.usage
      }
      yield chunk
    }
    const result = await stream.result
    const stepEnd: Extract<AgentEvent, { kind: 'step-end' }> = {
      kind: 'step-end', agentId: worker.agentId,
      stopReason: stopReason ?? result.stopReason ?? null,
      usage: toEngineUsage(usage), toolUseIds: tools.map(tool => tool.id), toolNames: tools.map(tool => tool.name),
    }
    if (stepEnd.toolUseIds.length === 0 && ['end_turn', 'max_tokens', 'stop_sequence'].includes(stepEnd.stopReason ?? ''))
      worker.pendingStepEnd = stepEnd
    else worker.sender.push(stepEnd)
    return result
  })

  on('tool.call', { tool: /^mcp__ccapi__/ }, async ($, event) => {
    const worker = runtime
    if (!worker) return { deny: 'ccapi tools are only available inside request sessions' }
    if (event.tool === TOOL_PREFIX + ATTACHMENTS_TOOL) {
      const ids = Array.isArray((event as { ids?: unknown }).ids) ? ((event as { ids: unknown[] }).ids).join(',') : ''
      const response = await $.http.fetch(`${worker.base}/internal/attachments/${worker.agentId}?ids=${ids}`, { headers: worker.headers })
      return response.ok ? { result: JSON.parse(response.text) as never } : { deny: `ccapi attachments unavailable (${response.status})` }
    }
    await worker.sender.flushed()
    const deadline = Date.now() + worker.toolWaitMs + 60_000
    let failures = 0
    while (Date.now() < deadline) {
      try {
        const response = await $.http.fetch(`${worker.base}/internal/wait/${event.tool_use_id}`, { headers: worker.headers })
        if (response.status === 200) {
          const result = JSON.parse(response.text) as EngineToolResult
          return 'deny' in result ? { deny: result.deny } : { result: result.result as never }
        }
        if (response.status !== 204 && ++failures >= 5) return { deny: `ccapi bridge answered ${response.status} while waiting` }
      } catch (error) {
        if (++failures >= 5) return { deny: `ccapi lost the bridge while waiting (${String(error)})` }
        await $.clock.sleep(500)
      }
    }
    return { deny: 'ccapi timed out waiting for the client tool result' }
  })

  on('turn.complete', async ($, event, next) => {
    const result = await next(event)
    const worker = runtime
    if (worker) {
      const answer = (result as { text?: unknown }).text ?? (event as { answer?: unknown }).answer
      const diagnosticText = [worker.streamedText, typeof answer === 'string' ? answer : ''].filter(Boolean).join('\n')
      const apiErrorIndex = diagnosticText.lastIndexOf('API Error:')
      const apiError = apiErrorIndex >= 0
        ? /API Error:\s*(?:(\d{3})\s+)?([\s\S]*)/i.exec(diagnosticText.slice(apiErrorIndex).trim())
        : undefined
      const status = apiError?.[1] ? Number(apiError[1]) : 502
      const upstreamFailure = apiError && apiError[2] !== undefined
        ? { status: status >= 400 && status <= 599 ? status : 502, message: apiError[2].trim().slice(-2000) }
        : undefined
      if (typeof answer === 'string' && answer !== '' && worker.streamedText === '' && event.reason !== 'error' && event.reason !== 'aborted')
        worker.sender.push({ kind: 'text', agentId: worker.agentId, index: 0, text: answer })
      worker.streamedText = ''
      if (worker.pendingStepEnd) worker.sender.push(worker.pendingStepEnd)
      worker.pendingStepEnd = undefined
      worker.sender.push({
        kind: 'turn-end', agentId: worker.agentId, reason: event.reason,
        ...(upstreamFailure ? { upstreamFailure } : {}),
      })
      await worker.sender.flushed()
    }
    return result
  })
}
