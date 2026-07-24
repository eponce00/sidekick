import type { ModelProvider } from './models'
import type { ProviderInstance, ProviderInstanceType } from './settings'

export type ProviderKind =
  | 'ollama'
  | 'ollama-cloud'
  | 'openrouter'
  | 'anthropic'
  | 'litellm'
  | 'lmstudio'
  | 'openai-compatible'
  | 'llamacpp'

export type ProviderProtocol = 'ollama' | 'openai-compatible' | 'anthropic'
export type ProviderCredentialMode = 'none' | 'optional' | 'required'
export type ProviderDiscoveryAdapter =
  | 'ollama-tags'
  | 'openrouter-catalog'
  | 'anthropic-models'
  | 'litellm-models'
  | 'openai-models'
  | 'manual'
export type ProviderContextAdapter =
  | 'ollama-show'
  | 'openrouter-catalog'
  | 'anthropic-models'
  | 'litellm-model-metadata'
  | 'lmstudio-native'
  | 'openai-model-metadata'
  | 'llamacpp-server'
export type ProviderHealthAdapter =
  | 'ollama-tags'
  | 'openrouter-catalog'
  | 'anthropic-models'
  | 'litellm-models'
  | 'openai-models'
export type ProviderModelLifecycle = 'none' | 'load-unload'

export interface ProviderCapabilities {
  credentials: ProviderCredentialMode
  discovery: ProviderDiscoveryAdapter
  context: ProviderContextAdapter
  health: ProviderHealthAdapter
  modelLifecycle: ProviderModelLifecycle
  reportsPricing: boolean
  reportsGenerationStats: boolean
  supportsThinkingToggle: boolean
  supportsVisionPayloads: boolean
}

export interface ProviderDefinition {
  kind: ProviderKind
  type: ProviderInstanceType
  preset?: ProviderInstance['preset']
  transport: ModelProvider
  protocol: ProviderProtocol
  name: string
  description: string
  defaultBaseUrl: string
  capabilities: ProviderCapabilities
}

export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = [
  {
    kind: 'ollama',
    type: 'ollama',
    transport: 'ollama',
    protocol: 'ollama',
    name: 'Ollama',
    description: 'Local or remote Ollama server',
    defaultBaseUrl: 'http://localhost:11434',
    capabilities: {
      credentials: 'none',
      discovery: 'ollama-tags',
      context: 'ollama-show',
      health: 'ollama-tags',
      modelLifecycle: 'none',
      reportsPricing: false,
      reportsGenerationStats: false,
      supportsThinkingToggle: true,
      supportsVisionPayloads: true
    }
  },
  {
    kind: 'lmstudio',
    type: 'openai-compatible',
    preset: 'lmstudio',
    transport: 'lmstudio',
    protocol: 'openai-compatible',
    name: 'LM Studio',
    description: 'LM Studio with model discovery and lifecycle support',
    defaultBaseUrl: 'http://localhost:1234/v1',
    capabilities: {
      credentials: 'optional',
      discovery: 'openai-models',
      context: 'lmstudio-native',
      health: 'openai-models',
      modelLifecycle: 'none',
      reportsPricing: false,
      reportsGenerationStats: false,
      supportsThinkingToggle: false,
      supportsVisionPayloads: true
    }
  },
  {
    kind: 'litellm',
    type: 'litellm',
    transport: 'litellm',
    protocol: 'openai-compatible',
    name: 'LiteLLM',
    description: 'LiteLLM gateway with model and capability discovery',
    defaultBaseUrl: 'http://localhost:4000/v1',
    capabilities: {
      credentials: 'optional',
      discovery: 'litellm-models',
      context: 'litellm-model-metadata',
      health: 'litellm-models',
      modelLifecycle: 'none',
      reportsPricing: true,
      reportsGenerationStats: false,
      supportsThinkingToggle: false,
      supportsVisionPayloads: true
    }
  },
  {
    kind: 'openai-compatible',
    type: 'openai-compatible',
    preset: 'generic',
    transport: 'lmstudio',
    protocol: 'openai-compatible',
    name: 'OpenAI-compatible',
    description: 'vLLM, OpenCode gateway, or custom OpenAI-compatible API',
    defaultBaseUrl: 'http://localhost:8000/v1',
    capabilities: {
      credentials: 'optional',
      discovery: 'openai-models',
      context: 'openai-model-metadata',
      health: 'openai-models',
      modelLifecycle: 'none',
      reportsPricing: false,
      reportsGenerationStats: false,
      supportsThinkingToggle: false,
      supportsVisionPayloads: true
    }
  },
  {
    kind: 'llamacpp',
    type: 'llamacpp',
    transport: 'llamacpp',
    protocol: 'openai-compatible',
    name: 'llama.cpp',
    description: 'Server-managed model and context window',
    defaultBaseUrl: 'http://localhost:8080/v1',
    capabilities: {
      credentials: 'none',
      discovery: 'manual',
      context: 'llamacpp-server',
      health: 'openai-models',
      modelLifecycle: 'none',
      reportsPricing: false,
      reportsGenerationStats: false,
      supportsThinkingToggle: false,
      supportsVisionPayloads: true
    }
  },
  {
    kind: 'anthropic',
    type: 'anthropic',
    transport: 'anthropic',
    protocol: 'anthropic',
    name: 'Anthropic',
    description: 'Native Claude Messages API with streaming and tool use',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    capabilities: {
      credentials: 'required',
      discovery: 'anthropic-models',
      context: 'anthropic-models',
      health: 'anthropic-models',
      modelLifecycle: 'none',
      reportsPricing: false,
      reportsGenerationStats: false,
      supportsThinkingToggle: true,
      supportsVisionPayloads: true
    }
  },
  {
    kind: 'openrouter',
    type: 'openrouter',
    transport: 'openrouter',
    protocol: 'openai-compatible',
    name: 'OpenRouter',
    description: 'Hosted catalog with model metadata and pricing',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    capabilities: {
      credentials: 'required',
      discovery: 'openrouter-catalog',
      context: 'openrouter-catalog',
      health: 'openrouter-catalog',
      modelLifecycle: 'none',
      reportsPricing: true,
      reportsGenerationStats: true,
      supportsThinkingToggle: true,
      supportsVisionPayloads: true
    }
  },
  {
    kind: 'ollama-cloud',
    type: 'ollama-cloud',
    transport: 'ollama-cloud',
    protocol: 'ollama',
    name: 'Ollama Cloud',
    description: 'Ollama-compatible hosted models',
    defaultBaseUrl: 'https://ollama.com',
    capabilities: {
      credentials: 'required',
      discovery: 'ollama-tags',
      context: 'ollama-show',
      health: 'ollama-tags',
      modelLifecycle: 'none',
      reportsPricing: false,
      reportsGenerationStats: false,
      supportsThinkingToggle: true,
      supportsVisionPayloads: true
    }
  }
]

export function providerDefinition(kind: ProviderKind): ProviderDefinition {
  const definition = PROVIDER_REGISTRY.find((candidate) => candidate.kind === kind)
  if (!definition) throw new Error(`Unknown provider kind: ${kind}`)
  return definition
}

export function providerKindForInstance(
  instance: Pick<ProviderInstance, 'type' | 'preset'>
): ProviderKind {
  if (instance.type === 'openai-compatible') {
    return instance.preset === 'lmstudio' ? 'lmstudio' : 'openai-compatible'
  }
  return instance.type
}

export function providerDefinitionForInstance(
  instance: Pick<ProviderInstance, 'type' | 'preset'>
): ProviderDefinition {
  return providerDefinition(providerKindForInstance(instance))
}

export function providerKindForTransport(transport: ModelProvider): ProviderKind {
  return transport === 'lmstudio' ? 'lmstudio' : transport
}

export function providerDefinitionForTransport(transport: ModelProvider): ProviderDefinition {
  return providerDefinition(providerKindForTransport(transport))
}

export function providerUsesOpenAIProtocol(kind: ProviderKind): boolean {
  return providerDefinition(kind).protocol === 'openai-compatible'
}
