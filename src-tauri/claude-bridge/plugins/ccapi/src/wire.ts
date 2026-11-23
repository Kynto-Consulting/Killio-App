// Protocol between the bridge and the two mods (JSON over the bridge's /internal routes).
import type { ContextManagement, Effort, UsageIteration } from './api.ts'

export type EngineUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type AgentPlan = {
  name: string
  prompt: string
  tools: string[]
  model: string
  effort?: Effort | number
}
export type WorkerJob = {
  convId: string
  sessionId: string
  runtimeKey: string
  resume: boolean
  model: string
  effort?: Effort | number
  systemPrompt: string
  prompt: string
  contextManagement?: ContextManagement
}

export type TurnEndReason = 'answer' | 'aborted' | 'refusal' | 'error'
export type UpstreamFailure = { status: number; message: string }

export type AgentEvent =
  | { kind: 'text'; agentId: string; index: number; text: string }
  | { kind: 'thinking'; agentId: string; index: number; text: string }
  | { kind: 'compaction'; agentId: string; content: string | null }
  | { kind: 'compaction-pause'; agentId: string }
  | { kind: 'usage-iterations'; agentId: string; iterations: UsageIteration[] }
  | { kind: 'tool'; agentId: string; index: number; id: string; name: string }
  | { kind: 'input'; agentId: string; index: number; json: string }
  | {
      kind: 'step-end'
      agentId: string
      stopReason: string | null
      usage: EngineUsage | null
      toolUseIds: string[]
      toolNames: string[]
    }
  | { kind: 'turn-end'; agentId: string; reason: TurnEndReason; upstreamFailure?: UpstreamFailure }

export type EngineToolResult = { result: string | Array<Record<string, unknown>> } | { deny: string }
