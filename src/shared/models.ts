import type { ProviderKind } from './providerRegistry'
import type { ReasoningLevel } from './reasoning'
import type { ProviderInstanceHealth } from './settings'
import type { EditingContractCalibration, EditingDialectPreference } from './workspaceMutations'

export type ModelProvider =
  | 'ollama'
  | 'ollama-cloud'
  | 'openrouter'
  | 'anthropic'
  | 'litellm'
  | 'lmstudio'
  | 'llamacpp'

export interface PinnedModel {
  id: string
  name: string
  provider: ModelProvider
  providerKind?: ProviderKind
  providerInstanceId?: string
  providerInstanceName?: string
  providerModelId?: string
  providerHealth?: ProviderInstanceHealth
  contextLength?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  /** See `ProviderInstanceModel.outputTokenLimit`. */
  outputTokenLimit?: number
  supportsTools?: boolean
  supportsVision?: boolean
  supportsReasoning?: boolean
  /** See `ProviderInstanceModel.reasoningLevels`. */
  reasoningLevels?: ReasoningLevel[]
  reasoningDefault?: ReasoningLevel
  supportsAudioInput?: boolean
  supportsAudioOutput?: boolean
  supportsPdfInput?: boolean
  editingDialect?: EditingDialectPreference
  upstreamModel?: string
  editingCalibration?: EditingContractCalibration
  pricing?: {
    prompt: number
    completion: number
  }
}
