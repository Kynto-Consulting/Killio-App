import type { ContextManagement, UsageIteration } from '../src/api.ts'

const MAX_CACHE_CONTROL_BLOCKS = 4

type CacheControlReference = { block: Record<string, unknown>; path: string[] }

const liftToolResultCacheControls = (value: unknown, parentToolResult?: Record<string, unknown>): number => {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + liftToolResultCacheControls(item, parentToolResult), 0)
  }
  if (typeof value !== 'object' || value === null) return 0
  const object = value as Record<string, unknown>
  const toolResult = object.type === 'tool_result' ? object : parentToolResult
  let moved = 0
  if (toolResult && object !== toolResult && typeof object.cache_control === 'object' && object.cache_control !== null) {
    if (typeof toolResult.cache_control !== 'object' || toolResult.cache_control === null)
      toolResult.cache_control = object.cache_control
    delete object.cache_control
    moved++
  }
  for (const [key, item] of Object.entries(object)) {
    if (key === 'cache_control') continue
    const childToolResult = key === 'tool_result' && typeof item === 'object' && item !== null && !Array.isArray(item)
      ? item as Record<string, unknown>
      : toolResult
    moved += liftToolResultCacheControls(item, childToolResult)
  }
  return moved
}

const cacheControlReferences = (value: unknown, path: string[] = []): CacheControlReference[] => {
  if (Array.isArray(value)) return value.flatMap((item, index) => cacheControlReferences(item, [...path, String(index)]))
  if (typeof value !== 'object' || value === null) return []
  const object = value as Record<string, unknown>
  const found: CacheControlReference[] = []
  if (typeof object.cache_control === 'object' && object.cache_control !== null)
    found.push({ block: object, path })
  for (const [key, item] of Object.entries(object)) {
    if (key !== 'cache_control') found.push(...cacheControlReferences(item, [...path, key]))
  }
  return found
}

// Claude Code can accumulate more cache breakpoints than Anthropic accepts after
// tool/image results. Keep system breakpoints and the newest remaining ones; removing
// a breakpoint never changes the message content, only which prefix is cached.
export const trimExcessCacheControls = (body: unknown): number => {
  liftToolResultCacheControls(body)
  const refs = cacheControlReferences(body)
  if (refs.length <= MAX_CACHE_CONTROL_BLOCKS) return 0

  const systemRefs = refs.filter(ref => ref.path[0] === 'system')
  const keep = new Set<CacheControlReference>(systemRefs.slice(0, MAX_CACHE_CONTROL_BLOCKS))
  const remaining = MAX_CACHE_CONTROL_BLOCKS - keep.size
  const nonSystemRefs = refs.filter(ref => ref.path[0] !== 'system')
  if (remaining > 0)
    for (const ref of nonSystemRefs.slice(-remaining)) keep.add(ref)

  let removed = 0
  for (const ref of refs) {
    if (keep.has(ref)) continue
    delete ref.block.cache_control
    removed++
  }
  return removed
}

const isLoopback = (hostname: string): boolean =>
  hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'

export const upstreamBaseUrl = (configured: string | undefined, bridgePort: number): string => {
  const candidate = configured?.trim() || 'https://api.anthropic.com'
  let url: URL
  try { url = new URL(candidate) }
  catch { throw new Error(`ccapi upstream base URL is invalid: ${candidate}`) }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('ccapi upstream base URL must use HTTP(S)')
  if (isLoopback(url.hostname.replace(/^\[|\]$/g, '')) && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === bridgePort)
    return 'https://api.anthropic.com'
  return url.toString().replace(/\/+$/, '')
}

export type AnthropicUpstreamOptions = {
  contextManagement?: () => ContextManagement | undefined
  onCompaction?: (content: string | null) => Promise<void> | void
  onCompactionPause?: () => Promise<void> | void
  onUsage?: (iterations: UsageIteration[]) => Promise<void> | void
}

const isCompactionEnabled = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Array.isArray((value as { edits?: unknown }).edits) &&
  (value as { edits: Array<{ type?: unknown }> }).edits.some(edit => edit?.type === 'compact_20260112')

const observeCompactionStream = (
  body: ReadableStream<Uint8Array>,
  onCompaction: (content: string | null) => Promise<void> | void,
  shouldPauseAfterCompaction: () => boolean,
  onCompactionPause?: () => Promise<void> | void,
  onUsage?: (iterations: UsageIteration[]) => Promise<void> | void,
): ReadableStream<Uint8Array> => {
  const decoder = new TextDecoder()
  const compactionIndexes = new Set<number>()
  let pending = ''
  const inspectFrame = async (frame: string): Promise<void> => {
    const data = frame.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') return
    try {
      const event = JSON.parse(data) as {
        type?: unknown
        index?: unknown
        content_block?: { type?: unknown; content?: unknown }
        delta?: { type?: unknown; content?: unknown; stop_reason?: unknown }
        usage?: { iterations?: unknown }
      }
      if (event.type === 'content_block_start' && event.content_block?.type === 'compaction' && typeof event.index === 'number') {
        compactionIndexes.add(event.index)
      } else if (
        event.type === 'content_block_delta' && event.delta?.type === 'compaction_delta' &&
        typeof event.index === 'number' && compactionIndexes.has(event.index)
      ) {
        await onCompaction(typeof event.delta.content === 'string' ? event.delta.content : null)
      } else if (event.type === 'message_delta') {
        if (Array.isArray(event.usage?.iterations) && onUsage) {
          const iterations = event.usage.iterations.filter((iteration): iteration is UsageIteration =>
            typeof iteration === 'object' && iteration !== null &&
            typeof (iteration as UsageIteration).type === 'string' &&
            typeof (iteration as UsageIteration).input_tokens === 'number' &&
            typeof (iteration as UsageIteration).output_tokens === 'number',
          )
          if (iterations.length > 0) await onUsage(iterations)
        }
        if (event.delta?.stop_reason === 'compaction' && compactionIndexes.size > 0 && shouldPauseAfterCompaction())
          await onCompactionPause?.()
      }
    } catch {}
  }

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      let boundary = pending.search(/\r?\n\r?\n/)
      while (boundary >= 0) {
        const frame = pending.slice(0, boundary)
        const separator = pending.slice(boundary).match(/^\r?\n\r?\n/)![0]
        pending = pending.slice(boundary + separator.length)
        await inspectFrame(frame)
        boundary = pending.search(/\r?\n\r?\n/)
      }
      controller.enqueue(chunk)
    },
    async flush() {
      pending += decoder.decode()
      if (pending !== '') await inspectFrame(pending)
    },
  }))
}

export const startAnthropicUpstreamProxy = (baseUrl: string, options: AnthropicUpstreamOptions = {}) => Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: async request => {
    const source = new URL(request.url)
    if (!source.pathname.startsWith('/v1/')) return new Response('not found', { status: 404 })

    const base = new URL(baseUrl)
    const target = new URL(base.toString())
    const basePath = base.pathname.replace(/\/+$/, '')
    const sourcePath = source.pathname
    target.pathname = basePath.endsWith('/v1') && sourcePath.startsWith('/v1/')
      ? `${basePath}${sourcePath.slice(3)}`
      : `${basePath}${sourcePath}`
    target.search = source.search

    const headers = new Headers(request.headers)
    headers.delete('host')
    headers.delete('content-length')
    headers.delete('connection')
    // Bun's fetch may transparently decompress the upstream response. Ask the
    // upstream for an identity body so the Claude SDK cannot try to decompress
    // an already-decoded stream a second time.
    headers.set('accept-encoding', 'identity')
    let body: BodyInit | undefined
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const bytes = await request.arrayBuffer()
      const contentType = request.headers.get('content-type') ?? ''
      if (source.pathname === '/v1/messages' && contentType.includes('application/json')) {
        try {
          const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
          const configuredContextManagement = options.contextManagement?.()
          if (configuredContextManagement && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
            (parsed as Record<string, unknown>).context_management = configuredContextManagement
          const moved = liftToolResultCacheControls(parsed)
          const removed = trimExcessCacheControls(parsed)
          if (removed > 0 || moved > 0 || configuredContextManagement !== undefined) {
            body = JSON.stringify(parsed)
            if (removed > 0 || moved > 0)
              console.warn(`ccapi upstream: lifted ${moved} tool_result cache_control breakpoint(s); trimmed ${removed} excess breakpoint(s)`)
          } else body = bytes
          const compactionEnabled = isCompactionEnabled(configuredContextManagement ?? (parsed as Record<string, unknown>).context_management)
          if (compactionEnabled) {
            const betas = (headers.get('anthropic-beta') ?? '').split(',').map(beta => beta.trim()).filter(Boolean)
            if (!betas.includes('compact-2026-01-12')) betas.push('compact-2026-01-12')
            headers.set('anthropic-beta', betas.join(','))
            console.log('ccapi upstream: Anthropic server compaction enabled')
          }
        } catch {
          body = bytes
        }
      } else body = bytes
    }

    let response: Response
    try {
      response = await fetch(target, { method: request.method, headers, ...(body !== undefined ? { body } : {}) })
    } catch (error) {
      return Response.json({ type: 'error', error: { type: 'api_error', message: `Anthropic upstream request failed: ${String(error)}` } }, { status: 502 })
    }
    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete('connection')
    responseHeaders.delete('content-length')
    responseHeaders.delete('transfer-encoding')
    responseHeaders.delete('content-encoding')
    let responseBody = response.body
    if (responseBody && options.onCompaction && response.headers.get('content-type')?.includes('text/event-stream'))
      responseBody = observeCompactionStream(
        responseBody,
        options.onCompaction,
        () => options.contextManagement?.()?.edits.some(edit => edit.pause_after_compaction === true) ?? false,
        options.onCompactionPause,
        options.onUsage,
      )
    else if ((options.onCompaction || options.onUsage) && response.headers.get('content-type')?.includes('application/json')) {
      try {
        const parsed = await response.clone().json() as {
          content?: Array<{ type?: unknown; content?: unknown }>
          usage?: { iterations?: UsageIteration[] }
          stop_reason?: unknown
        }
        if (options.onCompaction) for (const block of parsed.content ?? [])
          if (block.type === 'compaction') await options.onCompaction(typeof block.content === 'string' ? block.content : null)
        if (parsed.stop_reason === 'compaction' && options.contextManagement?.()?.edits.some(edit => edit.pause_after_compaction === true))
          await options.onCompactionPause?.()
        if (options.onUsage && parsed.usage?.iterations) await options.onUsage(parsed.usage.iterations)
      } catch {}
    }
    return new Response(responseBody, { status: response.status, statusText: response.statusText, headers: responseHeaders })
  },
})
