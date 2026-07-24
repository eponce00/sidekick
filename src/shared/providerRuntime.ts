import type { ProviderKind } from './providerRegistry'
import type { ProviderInstance, ProviderInstanceHealth, ProviderInstanceModel } from './settings'
import type {
  EditingContractCalibration,
  EditingDialectCalibrationResult,
  EditingDialectPreference
} from './workspaceMutations'

export interface ProviderToolCall {
  id?: string
  index?: number
  type?: string
  function: {
    name: string
    arguments?: Record<string, unknown> | string
  }
}

export type ProviderThinkingBlock =
  | {
      type: 'thinking'
      thinking: string
      signature: string
    }
  | {
      type: 'redacted_thinking'
      data: string
    }

export interface ProviderChatMessage {
  role: string
  content: string | null
  images?: string[]
  tool_calls?: ProviderToolCall[]
  tool_call_id?: string
  thinking_blocks?: ProviderThinkingBlock[]
}

export interface ProviderTarget {
  providerInstanceId?: string
  providerKind: ProviderKind
  model: string
  contextLength?: number
  maxOutputTokens?: number
  editingDialect?: EditingDialectPreference
  upstreamModel?: string
  editingCalibration?: EditingContractCalibration
}

export type ProviderRequestPurpose =
  | 'conversation'
  | 'continuation'
  | 'title'
  | 'checkpoint-title'
  | 'compaction'
  | 'web-extraction'
  | 'research'
  | 'sub-agent'
  | 'prompt-refinement'
  | 'editing-calibration'
  | 'other'

export interface ProviderChatRequest {
  target: ProviderTarget
  messages: ProviderChatMessage[]
  tools?: unknown[]
  maxOutputTokens?: number
  temperature?: number
  reasoningTokens?: number
  thinkingEnabled?: boolean
  purpose: ProviderRequestPurpose
}

export interface ProviderHealthChangedEvent {
  providerInstanceId: string
  health: ProviderInstanceHealth
  purpose: ProviderRequestPurpose
}

export interface ProviderStreamChunk {
  message?: {
    content?: string
    thinking?: string
    tool_calls?: ProviderToolCall[]
    thinking_blocks?: ProviderThinkingBlock[]
  }
  done?: boolean
  prompt_eval_count?: number
  eval_count?: number
  eval_duration?: number
  predicted_per_second?: number
  done_reason?: string
  error?: string
}

export interface ProviderStreamResult {
  ok: boolean
  error?: string
  generationId?: string
  status?: number
  retryAfter?: number
}

export interface ProviderCompletionData {
  message: {
    role: string
    content: string
    thinking?: string
    thinking_blocks?: ProviderThinkingBlock[]
    tool_calls?: ProviderToolCall[] | null
  }
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  finishReason: string
}

export interface ProviderCompletionResult {
  ok: boolean
  data?: ProviderCompletionData
  error?: string
  status?: number
  retryAfter?: number
}

export interface ProviderDiscoveryRequest {
  /** Existing persisted instance id, when editing a saved provider. */
  providerInstanceId?: string
  /** Draft settings are accepted only for provider setup/testing. */
  draft?: ProviderInstance
}

export interface ProviderDiscoveryResult {
  ok: boolean
  models?: ProviderInstanceModel[]
  error?: string
  status?: number
}

export interface ProviderEditingCalibrationRequest {
  providerInstanceId: string
  model: string
}

export interface ProviderEditingCalibrationResult {
  ok: boolean
  calibration?: EditingContractCalibration
  results?: EditingDialectCalibrationResult[]
  error?: string
}

export interface ProviderContextResult {
  ok: boolean
  contextLength?: number
  reliable: boolean
  source: 'configured' | 'provider' | 'fallback'
  error?: string
}

export interface ProviderGenerationStatsResult {
  ok: boolean
  data?: {
    id: string
    total_cost: number
    tokens_prompt: number
    tokens_completion: number
    native_tokens_reasoning?: number
    cache_discount?: number
    generation_time?: number
    model: string
  }
  error?: string
}
