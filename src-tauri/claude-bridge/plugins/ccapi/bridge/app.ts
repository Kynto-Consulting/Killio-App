import type { ContextManagement, Message, MessageResponse, MessagesRequest, Tool } from '../src/api.ts'
import type { AgentEvent, WorkerJob } from '../src/wire.ts'
import { ATTACHMENTS_ADDENDUM, buildAgentPlan, effortOf, toolChoiceAddendum } from '../src/agent-spec.ts'
import { ApiError, errorBody, toApiError } from '../src/errors.ts'
import { fnv1a } from '../src/hash.ts'
import { familyAlias, MODELS, resolveModel } from '../src/models.ts'
import { hydrateImageUrls } from './remote-images.ts'
import { renderConversation, systemText } from '../src/render.ts'
import { type Route, routeRequest } from '../src/router.ts'
import { estimateRequestTokens } from '../src/token-estimate.ts'
import { ATTACHMENTS_TOOL, modelVisibleName, schemaKey, stripPrefix, ToolNameRegistry } from '../src/tool-names.ts'
import { parseMessagesRequest } from '../src/validate.ts'
import { selectDeferredTools } from '../src/tool-search.ts'
import { type Conversation, ConversationStore } from './conversations.ts'
import { Limiter } from './limiter.ts'
import { JobQueue } from './queue.ts'
import { ResponseSink } from './sink.ts'

export type BridgeConfig = {
  token: string
  noToken?: boolean
  internalToken: string
  maxConcurrent: number
  queueSize: number
  toolWaitMs: number
  exposeThinking: 'requested' | 'always' | 'never'
  longPollMs: number
  maxParked: number
  debugBodies: boolean
  resumeCandidates?: PersistedResumeCandidate[]
  saveResumeCandidates?: (candidates: PersistedResumeCandidate[]) => void
  setWorkerContextManagement?: (sessionId: string, contextManagement: ContextManagement | undefined) => void
  log: (entry: Record<string, unknown>) => void
}

export type Health = { ok: true; active: number; queued: number; conversations: number; parked: number; total: number }

// A conversation that has no CLI process this long after it was queued is failed.
const SPAWN_TIMEOUT_MS = 90_000
// The deny a parked tool call gets when its client never comes back; it keeps the subagent's last reply short.
const CLIENT_GONE = 'The client closed this conversation. Do not call any tool; reply with just: ok'
const CLIENT_ENDED = 'The client ended this message before the tool ran. Do not call any tool; reply with just: ok'
const noContent = () => new Response(null, { status: 204 })
const RESUME_TTL_MS = 15 * 60_000
const MAX_RESUME_CANDIDATES = 64
const MAX_RESUME_MESSAGES = 2_000
const MIN_RESUME_SIMILARITY = 0.8
const MAX_LCS_CELLS = 1_000_000
const latestAttachmentCount = (messages: readonly Message[]): number => {
  const content = messages[messages.length - 1]?.content
  return Array.isArray(content) ? content.filter(block => block.type === 'image' || block.type === 'document').length : 0
}
const batchAttachmentInstruction = (count: number): string | undefined => count > 1
  ? `The message below references ${count} attachments. Fetch all of them in one ${modelVisibleName(ATTACHMENTS_TOOL)} call by passing every attachment ID in the ids array.`
  : undefined

export type PersistedResumeCandidate = {
  sessionId: string
  resumeKey: string
  history: string[]
  requestCacheKey?: string
  cachedResponse?: MessageResponse
  tools: string[]
  toolNames: Record<string, string>
  eagerTools: string[]
  at: number
  timedOutToolResult?: boolean
}
type ResumeCandidate = PersistedResumeCandidate
type ResumeMatch = {
  candidate: ResumeCandidate
  commonPrefix: number
  similarity: number
  unmatchedMessageIndexes?: number[]
}

const rememberResumeCandidate = (
  candidates: Map<string, ResumeCandidate>,
  conv: Conversation,
  timedOutToolResult = false,
): boolean => {
  if (!conv.sessionId || !conv.finalMessage) return false
  const messages = [...conv.messages, { role: 'assistant' as const, content: conv.finalMessage.content }]
  if (messages.length > MAX_RESUME_MESSAGES) return false
  const history = messages.map(messageKey)
  const candidate: ResumeCandidate = {
    sessionId: conv.sessionId,
    resumeKey: conv.resumeKey,
    history,
    requestCacheKey: conv.requestCacheKey,
    ...(conv.finalMessage.stop_reason === 'end_turn' && conv.finalMessage.content.every(block => block.type !== 'tool_use')
      ? { cachedResponse: conv.finalMessage }
      : {}),
    tools: conv.resumeTools,
    toolNames: conv.toolNames,
    eagerTools: [...(conv.eagerInputStreaming ?? [])],
    at: Date.now(),
    ...(timedOutToolResult ? { timedOutToolResult: true } : {}),
  }
  candidates.delete(candidate.sessionId)
  candidates.set(candidate.sessionId, candidate)
  while (candidates.size > MAX_RESUME_CANDIDATES) {
    const oldest = candidates.keys().next().value
    if (oldest === undefined) break
    candidates.delete(oldest)
  }
  return true
}

const messageKey = (message: unknown): string => {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (typeof value !== 'object' || value === null) return value
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
  }
  const text = JSON.stringify(canonical(message))
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    first = Math.imul(first ^ code, 0x01000193) >>> 0
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0
  }
  return `${text.length}:${first.toString(16)}:${second.toString(16)}`
}

const cacheKeyForRequest = (req: MessagesRequest): string => messageKey({ ...req, stream: undefined })

const matchingResume = (
  candidates: Map<string, ResumeCandidate>,
  resumeKey: string,
  messages: readonly Message[],
  activeTools: readonly string[],
  availableTools: readonly string[],
  hasAttachments: boolean,
  now: number,
): ResumeMatch | undefined => {
  if (messages[messages.length - 1]?.role !== 'user') return undefined
  const keys = messages.map(messageKey)
  let best: ResumeMatch | undefined
  for (const [key, candidate] of candidates) {
    if (now - candidate.at > RESUME_TTL_MS) {
      candidates.delete(key)
      continue
    }
    const candidateTools = new Set(candidate.tools)
    const toolsCompatible = activeTools.every(tool => candidateTools.has(tool)) && candidate.tools.every(tool =>
      tool === JSON.stringify([ATTACHMENTS_TOOL, 'builtin']) ? hasAttachments : availableTools.includes(tool),
    )
    if (candidate.resumeKey !== resumeKey || !toolsCompatible) continue
    let commonPrefix = 0
    while (
      commonPrefix < candidate.history.length &&
      commonPrefix < keys.length &&
      candidate.history[commonPrefix] === keys[commonPrefix]
    ) commonPrefix++

    const similarity = historySimilarity(candidate.history, keys, commonPrefix)
    if (similarity < MIN_RESUME_SIMILARITY) continue
    if (
      !best || similarity > best.similarity ||
      (similarity === best.similarity && commonPrefix > best.commonPrefix) ||
      (similarity === best.similarity && commonPrefix === best.commonPrefix && candidate.at > best.candidate.at)
    ) best = { candidate, commonPrefix, similarity }
  }
  if (best) best.unmatchedMessageIndexes = unmatchedHistoryMessages(best.candidate.history, keys)
  return best
}

const historySimilarity = (a: readonly string[], b: readonly string[], commonPrefix: number): number => {
  if (b.length === 0) return 0
  if (a.length * b.length > MAX_LCS_CELLS) return commonPrefix / b.length

  let previous = new Uint32Array(b.length + 1)
  for (const key of a) {
    const current = new Uint32Array(b.length + 1)
    for (let j = 1; j <= b.length; j++) {
      current[j] = key === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!)
    }
    previous = current
  }
  return previous[b.length]! / b.length
}

// Keep resume delivery consistent with the LCS similarity score. A client can trim old
// messages from the beginning of its rolling window, leaving a high-overlap match with
// a zero-length common prefix. Replaying the whole transcript in that case defeats resume.
const unmatchedHistoryMessages = (a: readonly string[], b: readonly string[]): number[] | undefined => {
  if (a.length * b.length > MAX_LCS_CELLS) return undefined
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    const row = table[i]!
    const next = table[i + 1]!
    for (let j = b.length - 1; j >= 0; j--)
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!)
  }
  const matched = new Set<number>()
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      matched.add(j++)
      i++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++
    else j++
  }
  return b.map((_, index) => index).filter(index => !matched.has(index))
}

const cachedHaikuResponse = (
  candidates: Map<string, ResumeCandidate>,
  resumeKey: string,
  requestCacheKey: string,
  messages: readonly Message[],
  activeTools: readonly string[],
  availableTools: readonly string[],
  hasAttachments: boolean,
  now: number,
): ResumeCandidate | undefined => {
  if (messages[messages.length - 1]?.role !== 'user') return undefined
  const keys = messages.map(messageKey)
  for (const candidate of candidates.values()) {
    if (now - candidate.at > RESUME_TTL_MS) continue
    if (candidate.resumeKey !== resumeKey || candidate.requestCacheKey !== requestCacheKey || !candidate.cachedResponse) continue
    if (candidate.cachedResponse.stop_reason !== 'end_turn') continue
    if (candidate.history.length !== keys.length + 1) continue
    if (!keys.every((key, index) => candidate.history[index] === key)) continue
    const candidateTools = new Set(candidate.tools)
    const toolsCompatible = activeTools.every(tool => candidateTools.has(tool)) && candidate.tools.every(tool =>
      tool === JSON.stringify([ATTACHMENTS_TOOL, 'builtin']) ? hasAttachments : availableTools.includes(tool),
    )
    if (toolsCompatible) return candidate
  }
  return undefined
}

const replayCachedResponse = async (req: MessagesRequest, cached: MessageResponse): Promise<Response> => {
  const sink = new ResponseSink({
    id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
    model: req.model,
    inputTokensEstimate: cached.usage.input_tokens,
    maxTokens: req.max_tokens,
    stopSequences: req.stop_sequences ?? [],
    exposeThinking: true,
    clientToolName: name => name,
  }, req.stream === true, () => {})
  let index = 0
  for (const block of cached.content) {
    if (block.type === 'text') sink.feed({ kind: 'text', agentId: 'cache', index: index++, text: block.text })
    else if (block.type === 'thinking') sink.feed({ kind: 'thinking', agentId: 'cache', index: index++, text: block.thinking })
  }
  sink.feed({
    kind: 'step-end', agentId: 'cache', stopReason: 'end_turn', usage: cached.usage,
    toolUseIds: [], toolNames: [],
  })
  return await sink.response
}

const explainResumeMiss = (
  candidates: Map<string, ResumeCandidate>,
  resumeKey: string,
  messages: readonly Message[],
  activeTools: readonly string[],
  availableTools: readonly string[],
  hasAttachments: boolean,
  now: number,
): string => {
  if (messages[messages.length - 1]?.role !== 'user') return 'latest_message_not_user'
  const live = [...candidates.values()].filter(candidate => now - candidate.at <= RESUME_TTL_MS)
  if (live.length === 0) return 'no_candidates'
  const sameContext = live.filter(candidate => candidate.resumeKey === resumeKey)
  if (sameContext.length === 0) return 'stable_context_mismatch'
  const compatible = sameContext.some(candidate => {
    const candidateTools = new Set(candidate.tools)
    return activeTools.every(tool => candidateTools.has(tool)) && candidate.tools.every(tool =>
      tool === JSON.stringify([ATTACHMENTS_TOOL, 'builtin']) ? hasAttachments : availableTools.includes(tool),
    )
  })
  return compatible ? 'history_below_80_percent' : 'tools_incompatible'
}

export const createBridge = (cfg: BridgeConfig) => {
  const store = new ConversationStore()
  const limiter = new Limiter(cfg.maxConcurrent, cfg.queueSize)
  const names = new ToolNameRegistry()
  const resumeCandidates = new Map<string, ResumeCandidate>((cfg.resumeCandidates ?? []).map(candidate => [candidate.sessionId, candidate]))
  const persistResumeCandidates = (): void => cfg.saveResumeCandidates?.([...resumeCandidates.values()])
  const workers = new JobQueue<WorkerJob>()
  let total = 0

  const fail = (err: ApiError) =>
    Response.json(errorBody(err), { status: err.status, ...(err.status === 429 ? { headers: { 'retry-after': '5' } } : {}) })

  const readJson = async (req: Request): Promise<unknown> => {
    try {
      return await req.json()
    } catch {
      throw new ApiError(400, 'invalid_request_error', 'body is not valid JSON')
    }
  }

  const authorized = (req: Request): boolean => {
    if (cfg.noToken) return true
    const key = req.headers.get('x-api-key') ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    return key === cfg.token
  }

  const health = (): Health => ({ ok: true, ...limiter.stats(), conversations: store.size, parked: store.parkedCount, total })

  const newSink = (
    req: MessagesRequest,
    convId: string,
    toolNames: Record<string, string>,
    eagerInputStreaming: ReadonlySet<string>,
    availableTools: readonly Tool[],
    route: 'fresh' | 'continue' | 'resume',
    resumeMatch?: ResumeMatch,
    resumeMissReason?: string,
    resumeCandidateCount = 0,
    resumeStatus?: { resumed?: boolean },
  ) => {
    const startedAt = Date.now()
    return new ResponseSink(
      {
        id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
        model: req.model,
        inputTokensEstimate: estimateRequestTokens({ ...req, tools: availableTools }),
        maxTokens: req.max_tokens,
        stopSequences: req.stop_sequences ?? [],
        exposeThinking: cfg.exposeThinking === 'always' || (cfg.exposeThinking === 'requested' && req.thinking?.type === 'enabled'),
        clientToolName: name => {
          const registered = stripPrefix(name)
          return registered === undefined || registered === ATTACHMENTS_TOOL ? undefined : toolNames[registered]
        },
        eagerInputStreaming: name => eagerInputStreaming.has(name),
      },
      req.stream === true,
      sink => {
        const message = sink.message()
        const resumed = route === 'continue' ? undefined : resumeStatus?.resumed === true
        cfg.log({
          convId,
          route: resumed === true ? 'resume' : route === 'continue' ? 'continue' : 'fresh',
          ...(resumed && resumeMatch ? {
            resumed: true,
            resumeSessionId: resumeMatch.candidate.sessionId,
            resumeSimilarity: resumeMatch.similarity,
            resumeInputMessages: req.messages.length,
            resumeOverlapMessages: Math.round(resumeMatch.similarity * req.messages.length),
            resumeHistoryMessages: resumeMatch.candidate.history.length,
            resumeCommonPrefixMessages: resumeMatch.commonPrefix,
            resumeDeltaMessages: Math.max(1, resumeMatch.unmatchedMessageIndexes?.length ?? req.messages.length - resumeMatch.commonPrefix),
          } : { resumed: false, resumeMissReason: resumeMatch ? 'resume_delivery_failed' : resumeMissReason, resumeCandidateCount }),
          model: req.model,
          stream: req.stream === true,
          ms: Date.now() - startedAt,
          stopReason: message.stop_reason,
          usage: message.usage,
          ...(cfg.debugBodies ? { request: req } : {}),
        })
      },
    )
  }

  // Takes a concurrency slot for this request; the returned release is safe to call more than once.
  const takeSlot = async (signal: AbortSignal): Promise<() => void> => {
    await limiter.acquire(signal)
    let released = false
    const release = () => {
      if (released) return
      released = true
      limiter.release()
    }
    if (signal.aborted) {
      release()
      throw new ApiError(499, 'api_error', 'the client closed the request')
    }
    return release
  }

  const denyClientTools = (sink: ResponseSink, reason: string): void => {
    for (const id of sink.clientToolUseIds) store.deliver(id, { deny: reason })
  }

  const bindAbort = (signal: AbortSignal, conv: Conversation, sink: ResponseSink): void => {
    const onAbort = () => {
      if (sink.isEnded) return
      sink.abandon()
      denyClientTools(sink, CLIENT_ENDED)
      if (conv.sink === sink) {
        conv.sink = undefined
        conv.detached = true
      }
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  const startConversation = async (req: MessagesRequest, signal: AbortSignal): Promise<Response> => {
    const model = resolveModel(req.model)
    const release = await takeSlot(signal)
    try {
      const convId = crypto.randomUUID()
      const rendered = renderConversation(req.messages)
      const clientTools: Tool[] = req.tool_choice?.type === 'none' ? [] : (req.tools ?? []).filter((tool): tool is Tool => tool.type !== 'tool_search_tool_bm25_20251119')
      const searchQuery = `${systemText(req.system)} ${rendered.prompt} ${req.tool_choice?.type === 'tool' ? req.tool_choice.name : ''}`
      const selectedDeferred = new Set(selectDeferredTools(clientTools, searchQuery).map(tool => tool.name))
      const activeTools = clientTools.filter(tool => tool.defer_loading !== true || selectedDeferred.has(tool.name))
      const eagerInputStreaming = new Set(activeTools.filter(tool => tool.eager_input_streaming === true).map(tool => tool.name))
      const toolNames: Record<string, string> = {}
      const clientToModel: Record<string, string> = {}
      const schemaKeys: string[] = []
      for (const tool of activeTools) {
        const key = schemaKey(tool.input_schema)
        const { registered } = names.bind(tool.name, key)
        toolNames[registered] = tool.name
        clientToModel[tool.name] = modelVisibleName(registered)
        schemaKeys.push(key)
      }
      const tools = Object.values(clientToModel)
      if (rendered.attachments.items.length > 0) tools.push(modelVisibleName(ATTACHMENTS_TOOL))
      const addenda = [
        toolChoiceAddendum(req.tool_choice, n => clientToModel[n] ?? n),
        rendered.attachments.items.length > 0 ? ATTACHMENTS_ADDENDUM : undefined,
      ].filter((s): s is string => s !== undefined)
      const effort = effortOf(req)
      const plan = buildAgentPlan({
        system: systemText(req.system),
        addenda,
        tools,
        toolSchemaKeys: schemaKeys,
        model,
        ...(effort !== undefined ? { effort } : {}),
      })
      const fallback = familyAlias(model)
      // Deferred BM25 selection changes the agent type hash per request. Match on the
      // stable context and separately ensure the old agent's tools remain compatible.
      const resumeKey = fnv1a(JSON.stringify([
        systemText(req.system), model, effort ?? null,
        req.tool_choice?.type === 'tool' ? ['tool', req.tool_choice.name] : req.tool_choice?.type ?? 'auto',
        rendered.attachments.items.length > 0,
      ]))
      const requestCacheKey = cacheKeyForRequest(req)
      const toolSignature = (tool: Tool): string => JSON.stringify([tool.name, schemaKey(tool.input_schema)])
      const activeToolSignatures = activeTools.map(toolSignature)
      const availableToolSignatures = clientTools.map(toolSignature)
      const resumeTools = [
        ...activeToolSignatures,
        ...(rendered.attachments.items.length > 0 ? [JSON.stringify([ATTACHMENTS_TOOL, 'builtin'])] : []),
      ]
      const cached = model.toLowerCase().includes('haiku') ? cachedHaikuResponse(
        resumeCandidates,
        resumeKey,
        requestCacheKey,
        req.messages,
        activeToolSignatures,
        availableToolSignatures,
        rendered.attachments.items.length > 0,
        Date.now(),
      ) : undefined
      if (cached?.cachedResponse) {
        cached.at = Date.now()
        persistResumeCandidates()
        cfg.log({ event: 'request_start', convId, model, route: 'cache', resumed: false, cached: true })
        const response = await replayCachedResponse(req, cached.cachedResponse)
        cfg.log({
          convId, route: 'cache', resumed: false, cached: true, cachedSessionId: cached.sessionId,
          model, stream: req.stream === true, ms: 0,
          stopReason: cached.cachedResponse.stop_reason, usage: cached.cachedResponse.usage,
          ...(cfg.debugBodies ? { request: req } : {}),
        })
        release()
        return response
      }
      const match = matchingResume(
        resumeCandidates,
        resumeKey,
        req.messages,
        activeToolSignatures,
        availableToolSignatures,
        rendered.attachments.items.length > 0,
        Date.now(),
      )
      const resumeMiss = match ? undefined : explainResumeMiss(
        resumeCandidates,
        resumeKey,
        req.messages,
        activeToolSignatures,
        availableToolSignatures,
        rendered.attachments.items.length > 0,
        Date.now(),
      )
      const resumeCandidateCount = resumeCandidates.size
      persistResumeCandidates()
      const resumedToolNames = match ? { ...toolNames, ...match.candidate.toolNames } : toolNames
      const resumedEagerInputStreaming = match
        ? new Set([...eagerInputStreaming, ...match.candidate.eagerTools])
        : eagerInputStreaming
      const resumeStatus: { resumed?: boolean } = { resumed: match !== undefined }
      const sink = newSink(req, convId, resumedToolNames, resumedEagerInputStreaming, activeTools, match ? 'resume' : 'fresh', match, resumeMiss, resumeCandidateCount, resumeStatus)
      const sessionId = match?.candidate.sessionId ?? crypto.randomUUID()
      const workerTools = activeTools.map(tool => {
        const registeredName = Object.entries(resumedToolNames).find(([, clientName]) => clientName === tool.name)?.[0] ?? tool.name
        return { name: registeredName, description: tool.description ?? tool.name, inputSchema: tool.input_schema }
      })
      const runtimeKey = fnv1a(JSON.stringify([
        model, plan.prompt, workerTools, rendered.attachments.items.length > 0,
        [...resumedEagerInputStreaming].sort(),
        req.context_management ?? null,
      ]))
      const conv: Conversation = {
        convId,
        model,
        resumeKey,
        requestCacheKey,
        runtimeKey,
        resumeTools: match ? match.candidate.tools : resumeTools,
        sessionId,
        systemPrompt: plan.prompt,
        ...(effort !== undefined ? { workerEffort: effort } : {}),
        ...(req.context_management !== undefined ? { contextManagement: req.context_management } : {}),
        workerTools,
        workerToolNames: resumedToolNames,
        resumeStatus,
        prompt: rendered.prompt,
        messages: req.messages,
        toolNames: resumedToolNames,
        eagerInputStreaming,
        attachments: rendered.attachments,
        sink,
        parked: [],
        detached: false,
        startedAt: Date.now(),
        release,
      }
      store.add(conv)
      store.bindAgent(convId, sessionId)
      if (sessionId !== convId) store.bindAgent(convId, convId)
      bindAbort(signal, conv, sink)
      cfg.log({
        event: 'request_start', convId, sessionId, model,
        route: match ? 'resume' : 'fresh', resumed: match !== undefined,
        ...(match ? {
          resumeSimilarity: match.similarity,
          resumeInputMessages: req.messages.length,
          resumeOverlapMessages: Math.round(match.similarity * req.messages.length),
          resumeHistoryMessages: match.candidate.history.length,
          resumeCommonPrefixMessages: match.commonPrefix,
          resumeDeltaMessages: Math.max(1, match.unmatchedMessageIndexes?.length ?? req.messages.length - match.commonPrefix),
        } : { resumeMissReason: resumeMiss, resumeCandidateCount }),
      })
      if (match) {
        const { candidate, commonPrefix } = match
        resumeCandidates.delete(candidate.sessionId)
        persistResumeCandidates()
        const inputExtendsSession = commonPrefix >= req.messages.length && candidate.history.length > req.messages.length
        const unmatchedIndexes = match.unmatchedMessageIndexes
        const deltaMessages = inputExtendsSession
          ? [req.messages[req.messages.length - 1]!]
          : unmatchedIndexes !== undefined
            ? unmatchedIndexes.length > 0
              ? unmatchedIndexes.map(index => req.messages[index]!)
              : [req.messages[req.messages.length - 1]!]
            : req.messages.slice(commonPrefix)
        const delta = renderConversation(deltaMessages)
        const deltaPrompt = [delta.prompt, batchAttachmentInstruction(latestAttachmentCount(req.messages))]
          .filter((part): part is string => part !== undefined)
          .join('\n\n')
        const noDelta = !inputExtendsSession && unmatchedIndexes !== undefined && unmatchedIndexes.length === 0
        const resumePrompt = inputExtendsSession
          ? [
              'The client supplied a transcript that matches this session up to the latest user message, but this session already contains later turns. Ignore those later turns and answer the latest user message again as a fresh request.',
              deltaPrompt,
            ].join('\n\n')
          : unmatchedIndexes !== undefined && (unmatchedIndexes.length > 0 || noDelta)
            ? [
                `The client sent a rolling transcript snapshot with about ${Math.round(match.similarity * req.messages.length)} messages overlapping this session. The messages below are only the new or changed entries from the current snapshot, in their original order${unmatchedIndexes.length > 0 ? ` (zero-based positions: ${unmatchedIndexes.join(', ')})` : `; the latest user message at position ${req.messages.length - 1} is repeated to request a fresh answer`}. Use the existing session for shared history, treat the supplied entries as authoritative, and do not act on stale requests that were pruned from the client's current snapshot.`,
                deltaPrompt,
              ].join('\n\n')
            : commonPrefix === candidate.history.length
              ? deltaPrompt
              : [
                  `The previous transcript is similar but differs after its first ${commonPrefix} messages. Ignore your earlier turns after that shared prefix; the following replacement tail is the authoritative conversation history.`,
                  deltaPrompt,
                ].join('\n\n')
        const authoritativePrompt = candidate.timedOutToolResult
          ? [
              'The previous run timed out while waiting for a client tool result and received a denial. The following conversation history contains the authoritative tool result; use it in place of that timeout denial.',
              resumePrompt,
            ].join('\n\n')
          : resumePrompt
        workers.push({
          convId,
          sessionId,
          runtimeKey,
          resume: true,
          model,
          ...(effort !== undefined ? { effort } : {}),
          systemPrompt: plan.prompt,
          prompt: authoritativePrompt,
          ...(req.context_management !== undefined ? { contextManagement: req.context_management } : {}),
        })
      } else {
        const prompt = [rendered.prompt, batchAttachmentInstruction(latestAttachmentCount(req.messages))]
          .filter((part): part is string => part !== undefined)
          .join('\n\n')
        workers.push({
          convId,
          sessionId,
          runtimeKey,
          resume: false,
          model: fallback ?? model,
          ...(effort !== undefined ? { effort } : {}),
          systemPrompt: plan.prompt,
          prompt,
          ...(req.context_management !== undefined ? { contextManagement: req.context_management } : {}),
        })
      }
      return await sink.response
    } catch (err) {
      release()
      throw err
    }
  }

  const continueConversation = async (
    req: MessagesRequest,
    route: Extract<Route, { kind: 'continue' }>,
    signal: AbortSignal,
  ): Promise<Response> => {
    const release = await takeSlot(signal)
    const conv = store.get(route.convId)
    // It may have expired or been evicted while this request waited for a slot.
    if (!conv) {
      release()
      return startConversation(req, signal)
    }
    conv.release = release
    conv.messages = req.messages
    conv.requestCacheKey = cacheKeyForRequest(req)
    conv.contextManagement = req.context_management
    cfg.setWorkerContextManagement?.(conv.sessionId, req.context_management)
    const availableTools = (req.tools ?? []).filter((tool): tool is Tool =>
      tool.type !== 'tool_search_tool_bm25_20251119' && Object.values(conv.toolNames).includes(tool.name),
    )
    const sink = newSink(req, conv.convId, conv.toolNames, conv.eagerInputStreaming ?? new Set(), availableTools, 'continue')
    conv.sink = sink
    conv.detached = false
    bindAbort(signal, conv, sink)
    cfg.log({ event: 'request_start', convId: conv.convId, model: conv.model, route: 'continue', resumed: false })
    for (const [id, result] of route.results) store.deliver(id, result)
    return sink.response
  }

  const handleEvent = (conv: Conversation, ev: AgentEvent): void => {
    if (ev.kind === 'turn-end') {
      const sink = conv.sink
      const alreadyCaptured = conv.finalMessage !== undefined
      sink?.feed(ev)
      if (sink?.isEnded) {
        conv.finalMessage = sink.message()
        conv.sink = undefined
      }
      if (ev.reason === 'answer' && !alreadyCaptured) {
        const saved = rememberResumeCandidate(resumeCandidates, conv)
        if (saved) persistResumeCandidates()
        cfg.log({ event: 'resume_candidate', convId: conv.convId, sessionId: conv.sessionId, reason: ev.reason, saved, candidateCount: resumeCandidates.size })
      }
      store.remove(conv.convId, 'the conversation has ended')
      return
    }
    const sink = conv.sink
    if (conv.detached || !sink) {
      if (ev.kind === 'tool') store.deliver(ev.id, { deny: CLIENT_ENDED })
      return
    }
    sink.feed(ev)
    if (!sink.isEnded) return
    conv.finalMessage = sink.message()
    conv.sink = undefined
    // The end_turn step already has the authoritative final response. Persist here too,
    // rather than relying solely on a later turn-end hook to reach the bridge.
    if ((sink.stopReason === 'end_turn' || sink.stopReason === 'compaction') && rememberResumeCandidate(resumeCandidates, conv)) {
      persistResumeCandidates()
      cfg.log({ event: 'resume_candidate', convId: conv.convId, sessionId: conv.sessionId, reason: 'end_turn', saved: true, candidateCount: resumeCandidates.size })
    }
    if (sink.stopReason === 'tool_use') {
      store.park(conv.convId, sink.clientToolUseIds, Date.now() + cfg.toolWaitMs)
      // A worker parked on a client tool is idle, so it holds no concurrency slot.
      conv.release()
      conv.release = () => {}
      const parked = store.parkedConversationIds()
      while (parked.length > cfg.maxParked) {
        const oldest = parked.shift()
        if (oldest !== undefined) store.remove(oldest, CLIENT_GONE)
      }
    } else {
      conv.detached = true
      denyClientTools(sink, CLIENT_ENDED)
    }
  }

  const onEvent = (ev: AgentEvent): void => {
    const conv = store.byAgent(ev.agentId)
    if (conv) return handleEvent(conv, ev)
    if (store.isDeadAgent(ev.agentId)) {
      if (ev.kind === 'tool') store.deliver(ev.id, { deny: CLIENT_GONE })
    }
  }

  const workerExit = async (req: Request): Promise<Response> => {
    const report = await readJson(req) as { convId?: unknown; exitCode?: unknown; stderr?: unknown }
    cfg.log({ event: 'worker_exit', convId: report.convId, exitCode: report.exitCode, ...(typeof report.stderr === 'string' && report.stderr ? { stderr: report.stderr.slice(-4000) } : {}) })
    const conv = typeof report.convId === 'string' ? store.get(report.convId) : undefined
    if (conv?.sink && !conv.sink.isEnded) {
      if (conv.resumeStatus?.resumed) {
        const failedSessionId = conv.sessionId
        conv.sessionId = crypto.randomUUID()
        conv.resumeStatus.resumed = false
        store.bindAgent(conv.convId, conv.sessionId)
        workers.push({
          convId: conv.convId,
          sessionId: conv.sessionId,
          runtimeKey: conv.runtimeKey,
          resume: false,
          model: conv.model,
          ...(conv.workerEffort !== undefined ? { effort: conv.workerEffort } : {}),
          systemPrompt: conv.systemPrompt,
          prompt: conv.prompt,
          ...(conv.contextManagement !== undefined ? { contextManagement: conv.contextManagement } : {}),
        })
        cfg.log({ event: 'resume_fallback', convId: conv.convId, failedSessionId, sessionId: conv.sessionId, exitCode: report.exitCode })
        return Response.json({ ok: true, fallback: true })
      }
      const detail = typeof report.stderr === 'string' ? report.stderr.trim().slice(-2000) : ''
      const message = 'Claude Code worker exited with code ' + String(report.exitCode) + (detail ? ': ' + detail : '')
      conv.sink.fail(new ApiError(502, 'api_error', message))
      store.remove(conv.convId, 'worker exited before completing the request')
    }
    return Response.json({ ok: true })
  }

  const internalRoute = async (req: Request, url: URL): Promise<Response> => {
    if (req.headers.get('x-ccapi-internal') !== cfg.internalToken)
      return fail(new ApiError(401, 'authentication_error', 'bad internal token'))
    const [, , route = '', arg = ''] = url.pathname.split('/')
    switch (`${req.method} ${route}`) {
      case 'GET next-worker': {
        const job = await workers.take(cfg.longPollMs, req.signal)
        if (!job) return noContent()
        if (req.signal.aborted) {
          workers.unshift(job)
          return noContent()
        }
        const conv = store.get(job.convId)
        if (conv) conv.workerStarted = true
        return Response.json(job)
      }
      case 'GET worker-config': {
        const conv = store.get(arg)
        if (!conv) return fail(new ApiError(404, 'not_found_error', 'unknown worker conversation'))
        return Response.json({
          convId: conv.convId,
          tools: conv.workerTools,
          toolNames: conv.workerToolNames,
          eagerTools: [...(conv.eagerInputStreaming ?? [])],
          attachments: conv.attachments.items.length > 0,
        })
      }
      case 'POST worker-exit':
        return workerExit(req)
      case 'POST events':
        for (const ev of (await readJson(req)) as AgentEvent[]) onEvent(ev)
        return Response.json({ ok: true })
      case 'GET wait': {
        const result = await store.wait(arg, cfg.longPollMs, req.signal)
        return result === undefined ? noContent() : Response.json(result)
      }
      case 'GET attachments': {
        const conv = store.byAgent(arg)
        if (!conv) return fail(new ApiError(404, 'not_found_error', 'unknown agent'))
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(s => s !== '').map(Number)
        return Response.json(conv.attachments.toToolResult(ids))
      }
      default:
        return fail(new ApiError(404, 'not_found_error', `no internal route ${req.method} ${route}`))
    }
  }

  const messages = async (req: Request): Promise<Response> => {
    const body = parseMessagesRequest(await readJson(req))
    body.messages = await hydrateImageUrls(body.messages)
    total++
    const route = routeRequest(body, ids => store.findParked(ids))
    return route.kind === 'continue' ? continueConversation(body, route, req.signal) : startConversation(body, req.signal)
  }

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    // Clients reach the routes as /v1/messages, /messages, or under the /anthropic gateway prefix (Hermes, others).
    const path = url.pathname.replace(/^\/anthropic(?=\/)/, '').replace(/^\/v1(?=\/)/, '')
    try {
      if (url.pathname.startsWith('/internal/')) return await internalRoute(req, url)
      if (req.method === 'GET' && path === '/health') return Response.json(health())
      if (!authorized(req)) throw new ApiError(401, 'authentication_error', 'invalid x-api-key')
      if (req.method === 'GET' && path === '/models')
        return Response.json({
          data: MODELS.map(m => ({ type: 'model', id: m.id, display_name: m.display_name, created_at: '2025-01-01T00:00:00Z' })),
          has_more: false,
          first_id: MODELS[0]?.id ?? null,
          last_id: MODELS[MODELS.length - 1]?.id ?? null,
        })
      if (req.method === 'POST' && path === '/messages/count_tokens') {
        const body = await readJson(req)
        if (typeof body !== 'object' || body === null || !Array.isArray((body as { messages?: unknown }).messages))
          throw new ApiError(400, 'invalid_request_error', 'messages: required array')
        return Response.json({ input_tokens: estimateRequestTokens(body as { messages: unknown }) })
      }
      if (req.method === 'POST' && path === '/messages') return await messages(req)
      throw new ApiError(404, 'not_found_error', `no route ${req.method} ${url.pathname}`)
    } catch (err) {
      return fail(toApiError(err))
    }
  }

  const sweep = (now: number): void => {
    for (const convId of store.expired(now)) {
      const conv = store.get(convId)
      if (conv) rememberResumeCandidate(resumeCandidates, conv, true)
      if (conv) persistResumeCandidates()
      store.remove(convId, CLIENT_GONE)
    }
    for (const conv of store.list()) {
      if (conv.workerStarted || now - conv.startedAt <= SPAWN_TIMEOUT_MS) continue
      conv.sink?.fail(new ApiError(500, 'api_error', 'ccapi could not start the Claude CLI worker in time'))
      store.remove(conv.convId, 'the worker never started')
    }
    store.prune(now)
  }

  return { fetch, sweep, health }
}
