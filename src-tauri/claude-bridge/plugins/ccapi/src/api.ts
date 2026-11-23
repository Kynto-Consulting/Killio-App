// Subset of the Anthropic Messages API that ccapi accepts and returns.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type CacheControl = { type: 'ephemeral'; ttl?: '5m' | '1h' }
export type TextBlock = { type: 'text'; text: string; cache_control?: CacheControl }
export type Base64Source = { type: 'base64'; media_type: string; data: string }
export type UrlSource = { type: 'url'; url: string }
export type ImageBlock = { type: 'image'; source: Base64Source | UrlSource; cache_control?: CacheControl }
export type DocumentBlock = {
  type: 'document'
  source: Base64Source | { type: 'text'; media_type: string; data: string }
  title?: string
  cache_control?: CacheControl
}
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
export type ServerToolUseBlock = { type: 'server_tool_use'; id: string; name: string; input: unknown; caller?: unknown }
export type ToolSearchToolResultBlock = { type: 'tool_search_tool_result'; tool_use_id: string; content: unknown }
export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content?: string | Array<TextBlock | ImageBlock | DocumentBlock>
  is_error?: boolean
}
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature?: string }
export type RedactedThinkingBlock = { type: 'redacted_thinking'; data: string }
export type ContentBlock =
  | TextBlock
  | ImageBlock
  | DocumentBlock
  | ToolUseBlock
  | ServerToolUseBlock
  | ToolSearchToolResultBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | CompactionBlock

export type Message = { role: 'user' | 'assistant'; content: string | ContentBlock[] }
export type Tool = {
  type?: 'custom'
  name: string
  description?: string
  input_schema: Record<string, unknown>
  defer_loading?: boolean
  eager_input_streaming?: boolean
  cache_control?: CacheControl
}
export type ToolSearchTool = {
  type: 'tool_search_tool_bm25_20251119'
  name: 'tool_search_tool_bm25'
  cache_control?: CacheControl
}
export type RequestTool = Tool | ToolSearchTool
export type ToolChoice = { type: 'auto' } | { type: 'any' } | { type: 'none' } | { type: 'tool'; name: string }
export type ContextManagement = {
  edits: Array<{
    type: 'compact_20260112'
    trigger?: { type: 'input_tokens'; value: number }
    pause_after_compaction?: boolean
    instructions?: string
  }>
}

export type MessagesRequest = {
  model: string
  max_tokens: number
  messages: Message[]
  system?: string | TextBlock[]
  tools?: RequestTool[]
  tool_choice?: ToolChoice
  stop_sequences?: string[]
  stream?: boolean
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' } | { type: 'adaptive' }
  output_config?: { effort?: Effort }
  context_management?: ContextManagement
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  iterations?: UsageIteration[]
}
export type UsageIteration = {
  type: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  [key: string]: unknown
}
export type CompactionBlock = { type: 'compaction'; content: string | null; cache_control?: CacheControl }
export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal' | 'compaction'
export type ResponseBlock = TextBlock | ToolUseBlock | { type: 'thinking'; thinking: string; signature: string } | CompactionBlock

export type MessageResponse = {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: ResponseBlock[]
  stop_reason: StopReason | null
  stop_sequence: string | null
  usage: Usage
}

export type SseEvent =
  | { type: 'message_start'; message: MessageResponse }
  | {
      type: 'content_block_start'
      index: number
      content_block:
        | TextBlock
        | { type: 'compaction'; content: string | null }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, never> }
        | { type: 'thinking'; thinking: string; signature: string }
    }
  | {
      type: 'content_block_delta'
      index: number
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'signature_delta'; signature: string }
        | { type: 'compaction_delta'; content: string | null }
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: StopReason; stop_sequence: string | null }; usage: Usage }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } }
