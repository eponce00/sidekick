import type { ProviderKind } from './providerRegistry'

/**
 * How much a model reasons before it answers. `on` turns reasoning on where a model has no levels;
 * the rest are the effort levels the major APIs share, each sent in the form its protocol expects.
 */
export type ReasoningLevel = 'off' | 'on' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  off: 'Off',
  on: 'On',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

/** From the least reasoning to the most. */
export const REASONING_INTENSITY: readonly ReasoningLevel[] = [
  'off',
  'on',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === 'string' && (REASONING_INTENSITY as readonly string[]).includes(value)
}

export interface ReasoningModel {
  id: string
  providerKind: ProviderKind
  /** The model id the server knows, when it differs from SideKick's pinned id. */
  model: string
  /** From discovery or the user: anything but true hides the control. */
  supportsReasoning?: boolean
  /** The levels the server says this model takes; empty when it offers no choice. */
  reasoningLevels?: readonly ReasoningLevel[]
  /** The level the model uses when a request names none, where the server says. */
  reasoningDefault?: ReasoningLevel
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

/**
 * What a protocol can carry, for a model whose server did not list its levels, with the level
 * to start from.
 */
function protocolOptions(model: ReasoningModel): ReasoningOptions {
  const id = model.model.toLowerCase()
  switch (model.providerKind) {
    case 'ollama':
    case 'ollama-cloud':
      // Ollama's `think` is on or off, except gpt-oss, which takes a level and cannot stop.
      return id.includes('gpt-oss')
        ? { levels: ['low', 'medium', 'high'], initial: 'medium' }
        : { levels: ['off', 'on'], initial: 'on' }
    case 'anthropic':
      return ADAPTIVE_CLAUDE.test(id)
        ? { levels: ['off', 'low', 'medium', 'high', 'max'], initial: 'off' }
        : { levels: ['off', 'low', 'medium', 'high'], initial: 'off' }
    case 'openrouter':
    case 'litellm':
      // Both translate the OpenAI effort scale for every upstream they route to.
      return {
        levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
        initial: model.providerKind === 'openrouter' ? 'off' : 'medium'
      }
    case 'llamacpp':
      // llama.cpp switches thinking through the model's chat template.
      return { levels: ['off', 'on'], initial: 'on' }
    case 'lmstudio':
    case 'openai-compatible':
      return { levels: ['off', 'low', 'medium', 'high'], initial: 'medium' }
  }
}

/**
 * The levels to offer for a model, or null when there is nothing to choose: the model cannot
 * reason, cannot change how much, or nobody knows. Levels its server lists win over what the
 * protocol could carry, so the control offers exactly what the model takes.
 */
export function reasoningOptions(model: ReasoningModel): ReasoningOptions | null {
  if (model.supportsReasoning !== true) return null
  const fallback = protocolOptions(model)
  const listed = model.reasoningLevels
  const levels = REASONING_INTENSITY.filter((level) => (listed ?? fallback.levels).includes(level))
  if (levels.length < 2) return null
  const initial = [model.reasoningDefault, fallback.initial].find(
    (level): level is ReasoningLevel => level !== undefined && levels.includes(level)
  )
  return { levels, initial: initial ?? levels[Math.floor(levels.length / 2)] }
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
  const at = Math.max(0, scale.indexOf(level === 'on' ? 'medium' : level))
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
