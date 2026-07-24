import type { ProviderSettings } from '../types/app.types'
import type { ModelProvider } from '../../../shared/models'

/**
 * Resolve which model to use for utility/background LLM tasks
 * (SmartFetch preprocessing, title generation, auto compact summarization).
 * Returns the configured fast model for the current provider, or falls back
 * to the main model if none is configured.
 */
export function resolveFastModel(
  currentProvider: ModelProvider,
  currentModelName: string,
  settings: ProviderSettings
): {
  provider: ModelProvider
  modelName: string
} {
  const fastMap: Record<string, string | undefined> = {
    ollama: settings.fastModelOllama,
    'ollama-cloud': settings.fastModelOllamaCloud,
    openrouter: settings.fastModelOpenRouter,
    anthropic: settings.fastModelAnthropic,
    litellm: undefined,
    lmstudio: settings.fastModelLMStudio,
    llamacpp: settings.fastModelLlamaCpp
  }
  const fastModelName = fastMap[currentProvider]
  if (fastModelName) {
    return { provider: currentProvider, modelName: fastModelName }
  }
  return { provider: currentProvider, modelName: currentModelName }
}
