import type { PermissionMode } from './permissions'
import type { McpServerConfig } from './types'
import type { EditingContractCalibration, EditingDialectPreference } from './workspaceMutations'

export type ProviderInstanceType =
  | 'ollama'
  | 'ollama-cloud'
  | 'openrouter'
  | 'anthropic'
  | 'litellm'
  | 'openai-compatible'
  | 'llamacpp'

export type ProviderModelMetadataSource = 'provider' | 'configured' | 'inferred' | 'unknown'

export interface ProviderModelMetadataOverrides {
  contextLength?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  supportsTools?: boolean
  supportsVision?: boolean
  supportsReasoning?: boolean
  supportsAudioInput?: boolean
  supportsAudioOutput?: boolean
  supportsPdfInput?: boolean
}

export interface ProviderInstanceModel {
  id: string
  name?: string
  enabled: boolean
  contextLength?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  supportsTools?: boolean
  supportsVision?: boolean
  supportsReasoning?: boolean
  supportsAudioInput?: boolean
  supportsAudioOutput?: boolean
  supportsPdfInput?: boolean
  metadataSource?: ProviderModelMetadataSource
  metadataOverrides?: ProviderModelMetadataOverrides
  /** Selects the one file-editing contract exposed to this model. */
  editingDialect?: EditingDialectPreference
  /** Actual upstream model identity exposed by a gateway such as LiteLLM. */
  upstreamModel?: string
  /** Last successful active compatibility calibration for this exact model identity. */
  editingCalibration?: EditingContractCalibration
  pricing?: { prompt: number; completion: number }
}

export type ProviderHealthStatus = 'unknown' | 'online' | 'offline'

export interface ProviderInstanceHealth {
  status: ProviderHealthStatus
  checkedAt?: number
  message?: string
  discoveredModelCount?: number
}

export interface ProviderInstance {
  id: string
  name: string
  type: ProviderInstanceType
  preset?: 'generic' | 'lmstudio'
  enabled: boolean
  baseUrl: string
  apiKey?: string
  /** Public renderer-safe indication; the stored secret never needs to be revealed. */
  apiKeyConfigured?: boolean
  modelSource: 'discover' | 'manual'
  models: ProviderInstanceModel[]
  fastModelId?: string
  health?: ProviderInstanceHealth
}

export interface ProviderSettings {
  providerInstances?: ProviderInstance[]
  openRouterApiKey: string
  ollamaEndpoint: string
  ollamaCloudApiKey?: string
  ollamaCloudBaseUrl?: string
  lmStudioEndpoint: string
  lmStudioApiKey?: string
  llamaCppEndpoint: string
  selectedModel?: string
  /** Pinned model id used for Plan mode. Empty means use the current chat model. */
  planningModelId?: string
  accentPalette?: string
  /** Semantic conversation text size. Interface zoom remains an independent window control. */
  contentFontSize?: number
  focusChainEnabled?: boolean
  focusChainReminderInterval?: number
  autoCompactEnabled?: boolean
  autoCompactThreshold?: number
  notificationsEnabled?: boolean
  notificationSoundEnabled?: boolean
  manualLocation?: string
  fastModelOllama?: string
  fastModelOllamaCloud?: string
  fastModelOpenRouter?: string
  fastModelAnthropic?: string
  fastModelLMStudio?: string
  fastModelLlamaCpp?: string
  ollamaThinkingEnabled?: boolean
  openRouterThinkingEnabled?: boolean
  toolCallLimit?: number
  toolCallLimitVersion?: number
  commandPermissionMode?: PermissionMode
  mcpServers?: McpServerConfig[]
}

export type PublicProviderInstance = Omit<ProviderInstance, 'apiKey'> & {
  apiKeyConfigured: boolean
}

export type PublicProviderSettings = Omit<
  ProviderSettings,
  'providerInstances' | 'openRouterApiKey' | 'ollamaCloudApiKey' | 'lmStudioApiKey'
> & {
  providerInstances?: PublicProviderInstance[]
  openRouterApiKeyConfigured: boolean
  ollamaCloudApiKeyConfigured: boolean
  lmStudioApiKeyConfigured: boolean
}
