import type { ReasoningLevel } from './reasoning'
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
  /** A configured output budget, from the user or a gateway's model settings. */
  maxOutputTokens?: number
  /**
   * The most a public catalog says the model can write in one reply. It caps the default output
   * budget and never raises it.
   */
  outputTokenLimit?: number
  supportsTools?: boolean
  supportsVision?: boolean
  supportsReasoning?: boolean
  /** The reasoning levels the server says the model takes; empty when it offers no choice. */
  reasoningLevels?: ReasoningLevel[]
  /** The level the model uses when a request names none, where the server says. */
  reasoningDefault?: ReasoningLevel
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
  /**
   * How many runs may use this provider at once: chats, scheduled runs, chats other chats
   * started, and sub-agents together. One for a server on this machine and four for a hosted
   * provider when unset; see `providerRunsAtOnce`.
   */
  runsAtOnce?: number
  /** The earlier sub-agent-only limit. Read as `runsAtOnce` when that is unset. */
  subAgentsAtOnce?: number
  health?: ProviderInstanceHealth
}

export interface ProviderSettings {
  shellIsolation?: 'host' | 'docker'
  /** Explicit user-selected canonical host Python; unset means no direct Office tools. */
  officeHelperInterpreter?: string
  /** Main-owned identity invalidates pending helper requests when configuration changes. */
  officeHelperConfigurationId?: string
  projectStartHooks?: import('./projectHooks').ProjectStartHook[]
  projectCompletionHooks?: import('./projectHooks').ProjectStartHook[]
  projectWorktreeHooks?: import('./projectHooks').ProjectStartHook[]
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
  /** The look the accent choice was made under; an older one moves to the current default once. */
  accentPaletteVersion?: number
  /** Size of the whole window in percent, one of `TEXT_SCALES`; Ctrl + and Ctrl − step it. */
  textScale?: number
  focusChainEnabled?: boolean
  autoCompactEnabled?: boolean
  autoCompactThreshold?: number
  notificationsEnabled?: boolean
  notificationSoundEnabled?: boolean
  /** Local dictation and read-aloud, and the background download of their models. On unless false. */
  voiceEnabled?: boolean
  /** Lets the agent search the web through public search engines. On unless false. */
  webSearchEnabled?: boolean
  /** Checks GitHub Releases for updates after startup and every six hours. On unless false. */
  automaticUpdateChecks?: boolean
  /**
   * Windows and Linux: closing the window hides SideKick to the tray, where its agents keep
   * working. On unless false. macOS keeps its Dock behavior and ignores it.
   */
  closeToTray?: boolean
  manualLocation?: string
  fastModelOllama?: string
  fastModelOllamaCloud?: string
  fastModelOpenRouter?: string
  fastModelAnthropic?: string
  fastModelLMStudio?: string
  fastModelLlamaCpp?: string
  /** The older on/off switches; they now only seed a model's starting reasoning level. */
  ollamaThinkingEnabled?: boolean
  openRouterThinkingEnabled?: boolean
  /** The reasoning level chosen for each pinned model, by its id. */
  reasoningLevels?: Record<string, ReasoningLevel>
  toolCallLimit?: number
  /** Runs that may work at once across the app; others wait in line. 1 to 8, four when unset. */
  maxConcurrentRuns?: number
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
