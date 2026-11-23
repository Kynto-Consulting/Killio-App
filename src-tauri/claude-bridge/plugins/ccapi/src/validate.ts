import type { MessagesRequest } from './api.ts'
import { ApiError } from './errors.ts'

const SUPPORTED_BLOCKS = new Set([
  'text', 'image', 'document', 'tool_use', 'server_tool_use', 'tool_search_tool_result', 'tool_result', 'thinking', 'redacted_thinking',
  'compaction',
])
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

const bad = (message: string) => new ApiError(400, 'invalid_request_error', message)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const checkBlock = (block: unknown, where: string): void => {
  if (!isObject(block) || typeof block.type !== 'string') throw bad(`${where}: each content block needs a string "type"`)
  if (!SUPPORTED_BLOCKS.has(block.type)) throw bad(`${where}: content block type "${block.type}" is not supported by ccapi`)
  if (block.type === 'image' || block.type === 'document') {
    const source = block.source
    if (!isObject(source)) throw bad(`${where}: ${block.type} blocks need a valid source`)
    if (source.type === 'url' && (block.type !== 'image' || typeof source.url !== 'string' || source.url === ''))
      throw bad(`${where}: URL sources are supported only for images and need a URL`)
    if (source.type !== 'url' && source.type !== 'base64' && !(block.type === 'document' && source.type === 'text'))
      throw bad(`${where}: ${block.type} source type is not supported`)
  }
  if (block.type === 'tool_result' && Array.isArray(block.content))
    block.content.forEach((inner, i) => checkBlock(inner, `${where}.content[${i}]`))
  if (block.type === 'compaction' && block.content !== null && typeof block.content !== 'string')
    throw bad(`${where}.content: compaction content must be a string or null`)
  if (block.type === 'server_tool_use') {
    if (typeof block.id !== 'string' || typeof block.name !== 'string' || !isObject(block.input))
      throw bad(`${where}: server_tool_use blocks need an id, name and object input`)
  }
  if (block.type === 'tool_search_tool_result') {
    if (typeof block.tool_use_id !== 'string' || !isObject(block.content))
      throw bad(`${where}: tool_search_tool_result blocks need a tool_use_id and object content`)
  }
}

const checkMessage = (message: unknown, i: number): void => {
  const where = `messages[${i}]`
  if (!isObject(message) || (message.role !== 'user' && message.role !== 'assistant'))
    throw bad(`${where}: role must be "user" or "assistant"`)
  if (typeof message.content === 'string') return
  if (!Array.isArray(message.content)) throw bad(`${where}: content must be a string or an array of blocks`)
  message.content.forEach((block, j) => checkBlock(block, `${where}.content[${j}]`))
}

export const parseMessagesRequest = (body: unknown): MessagesRequest => {
  if (!isObject(body)) throw bad('body must be a JSON object')
  if (typeof body.model !== 'string' || body.model === '') throw bad('model: required string')
  if (typeof body.max_tokens !== 'number' || !Number.isInteger(body.max_tokens) || body.max_tokens < 1)
    throw bad('max_tokens: required positive integer')
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw bad('messages: required non-empty array')
  body.messages.forEach(checkMessage)
  if (
    body.system !== undefined &&
    typeof body.system !== 'string' &&
    !(Array.isArray(body.system) && body.system.every(b => isObject(b) && b.type === 'text' && typeof b.text === 'string'))
  )
    throw bad('system: must be a string or an array of text blocks')
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw bad('tools: must be an array')
    body.tools.forEach((tool, i) => {
      if (!isObject(tool)) throw bad(`tools[${i}]: must be an object`)
      if (tool.type === 'tool_search_tool_bm25_20251119') {
        if (tool.name !== 'tool_search_tool_bm25') throw bad(`tools[${i}]: tool search name must be "tool_search_tool_bm25"`)
        if (tool.defer_loading === true) throw bad(`tools[${i}]: tool search cannot be deferred`)
        return
      }
      if (tool.type !== undefined && tool.type !== 'custom')
        throw bad(`tools[${i}]: server tool type "${String(tool.type)}" is not supported by ccapi`)
      if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) throw bad(`tools[${i}].name: must match ${TOOL_NAME}`)
      if (!isObject(tool.input_schema)) throw bad(`tools[${i}].input_schema: required object`)
      if (tool.defer_loading !== undefined && typeof tool.defer_loading !== 'boolean') throw bad(`tools[${i}].defer_loading: must be a boolean`)
      if (tool.eager_input_streaming !== undefined && typeof tool.eager_input_streaming !== 'boolean')
        throw bad(`tools[${i}].eager_input_streaming: must be a boolean`)
    })
    const hasDeferred = body.tools.some(tool => isObject(tool) && tool.type !== 'tool_search_tool_bm25_20251119' && tool.defer_loading === true)
    const hasToolSearch = body.tools.some(tool => isObject(tool) && tool.type === 'tool_search_tool_bm25_20251119')
    if (hasDeferred && !hasToolSearch) throw bad('tools: deferred tools require tool_search_tool_bm25_20251119')
  }
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice
    if (!isObject(choice) || !['auto', 'any', 'none', 'tool'].includes(String(choice.type)))
      throw bad('tool_choice.type: must be auto, any, none or tool')
    if (choice.type === 'tool' && typeof choice.name !== 'string') throw bad('tool_choice.name: required for type "tool"')
  }
  if (
    body.stop_sequences !== undefined &&
    !(Array.isArray(body.stop_sequences) && body.stop_sequences.every(s => typeof s === 'string' && s !== ''))
  )
    throw bad('stop_sequences: must be an array of non-empty strings')
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw bad('stream: must be a boolean')
  if (body.context_management !== undefined) {
    if (!isObject(body.context_management) || !Array.isArray(body.context_management.edits))
      throw bad('context_management.edits: must be an array')
    body.context_management.edits.forEach((edit, i) => {
      if (!isObject(edit) || edit.type !== 'compact_20260112')
        throw bad(`context_management.edits[${i}].type: only "compact_20260112" is supported`)
      if (edit.trigger !== undefined && (
        !isObject(edit.trigger) || edit.trigger.type !== 'input_tokens' ||
        typeof edit.trigger.value !== 'number' || !Number.isInteger(edit.trigger.value) || edit.trigger.value < 50_000
      )) throw bad(`context_management.edits[${i}].trigger: must use input_tokens with a value of at least 50000`)
      if (edit.pause_after_compaction !== undefined && typeof edit.pause_after_compaction !== 'boolean')
        throw bad(`context_management.edits[${i}].pause_after_compaction: must be a boolean`)
      if (edit.instructions !== undefined && typeof edit.instructions !== 'string')
        throw bad(`context_management.edits[${i}].instructions: must be a string`)
    })
  }
  return body as MessagesRequest
}
