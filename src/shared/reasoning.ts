import type { ProviderKind } from './providerRegistry'

/**
 * How much a model reasons before it answers. `auto` sends nothing and lets the model or server
 * decide; `on` turns reasoning on where a protocol has no levels; the rest are the effort levels
 * the major APIs share, each sent in the form its protocol expects.
 */
export type ReasoningLevel =
  | 'auto'
  | 'off'
  | 'on'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  auto: 'Model default',
  off: 'Off',
  on: 'On',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

export interface ReasoningModel {
  id: string
  providerKind: ProviderKind
  /** The model id the server knows, when it differs from SideKick's pinned id. */
  model: string
  /** From discovery: false hides the control, unknown keeps it. */
  supportsReasoning?: boolean
}

export interface ReasoningSettings {
  reasoningLevels?: Record<string, ReasoningLevel>
  ollamaThinkingEnabled?: boolean
  openRouterThinkingEnabled?: boolean
}

export interface ReasoningOptions {
  levels: ReasoningLevel[]
  initial: ReasoningLevel
}

// Claude models that think adaptively and take an effort level instead of a token budget.
const ADAPTIVE_CLAUDE = /(?:opus-4-[5-9]|sonnet-4-[6-9]|sonnet-5|haiku-5|mythos|fable)/

/** The levels a model's protocol and server can carry, or null where there is nothing to set. */
export function reasoningOptions(model: ReasoningModel): ReasoningOptions | null {
  if (model.supportsReasoning === false) return null
  const id = model.model.toLowerCase()
  switch (model.providerKind) {
    case 'ollama':
    case 'ollama-cloud':
      // Ollama's `think` is on or off, except gpt-oss, which takes a level and cannot stop.
      return id.includes('gpt-oss')
        ? { levels: ['low', 'medium', 'high'], initial: 'medium' }
        : { levels: ['on', 'off'], initial: 'on' }
    case 'anthropic':
      return ADAPTIVE_CLAUDE.test(id)
        ? { levels: ['off', 'low', 'medium', 'high', 'max'], initial: 'off' }
        : { levels: ['off', 'low', 'medium', 'high'], initial: 'off' }
    case 'openrouter':
    case 'litellm':
      // Both translate the OpenAI effort scale for every upstream they route to.
      return {
        levels: ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
        initial: model.providerKind === 'openrouter' ? 'off' : 'auto'
      }
    case 'llamacpp':
      // llama.cpp can only switch thinking through the model's chat template.
      return { levels: ['auto', 'on', 'off'], initial: 'auto' }
    case 'lmstudio':
    case 'openai-compatible':
      return { levels: ['auto', 'off', 'low', 'medium', 'high'], initial: 'auto' }
  }
}

/**
 * The level to send for a model: the one chosen for it, if this model offers it, else the
 * model's starting level. The older per-provider switches seed that starting level.
 */
export function resolveReasoningLevel(
  model: ReasoningModel,
  settings: ReasoningSettings
): ReasoningLevel | undefined {
  const options = reasoningOptions(model)
  if (!options) return undefined
  const chosen = settings.reasoningLevels?.[model.id]
  if (chosen && options.levels.includes(chosen)) return chosen
  if (
    (model.providerKind === 'ollama' || model.providerKind === 'ollama-cloud') &&
    settings.ollamaThinkingEnabled === false &&
    options.levels.includes('off')
  )
    return 'off'
  if (model.providerKind === 'openrouter' && settings.openRouterThinkingEnabled) return 'medium'
  return options.initial
}

/** The level after this one, for the command palette's cycle. */
export function nextReasoningLevel(
  options: ReasoningOptions,
  level: ReasoningLevel
): ReasoningLevel {
  const at = options.levels.indexOf(level)
  return options.levels[(at + 1) % options.levels.length]
}

/** Effort levels, nearest first, for protocols that accept only some of them. */
export function nearestEffort<T extends string>(level: ReasoningLevel, accepted: readonly T[]): T {
  const scale: ReasoningLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const at = Math.max(0, scale.indexOf(level === 'on' || level === 'auto' ? 'medium' : level))
  let best = accepted[0]
  let distance = Number.POSITIVE_INFINITY
  for (const candidate of accepted) {
    const gap = Math.abs(scale.indexOf(candidate as ReasoningLevel) - at)
    if (gap < distance) {
      best = candidate
      distance = gap
    }
  }
  return best
}

/** The level a request carries: its own, or the older on/off switch some callers still set. */
export function requestReasoningLevel(request: {
  reasoningLevel?: ReasoningLevel
  thinkingEnabled?: boolean
}): ReasoningLevel | undefined {
  if (request.reasoningLevel) return request.reasoningLevel
  if (request.thinkingEnabled === false) return 'off'
  return request.thinkingEnabled ? 'on' : undefined
}
