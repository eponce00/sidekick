import { isReasoningLevel, REASONING_INTENSITY, type ReasoningLevel } from '../../shared/reasoning'

/**
 * What a server says about a model's reasoning: whether it reasons, the levels a request may set,
 * and the level it uses when a request sets none. Each reader takes the server's own documented
 * fields; a field the server leaves out stays unknown.
 */
export interface ReasoningCapabilities {
  supportsReasoning?: boolean
  reasoningLevels?: ReasoningLevel[]
  reasoningDefault?: ReasoningLevel
}

const EFFORTS: readonly ReasoningLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** One of a server's own level names, in SideKick's terms. */
function levelFrom(value: unknown): ReasoningLevel | undefined {
  if (value === true) return 'on'
  if (value === false || value === 'none') return 'off'
  return isReasoningLevel(value) ? value : undefined
}

function levelsFrom(values: unknown): ReasoningLevel[] | undefined {
  if (!Array.isArray(values)) return undefined
  const levels = new Set(values.map(levelFrom).filter((level) => level !== undefined))
  return REASONING_INTENSITY.filter((level) => levels.has(level))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function supported(value: unknown): boolean {
  return record(value)?.supported === true
}

/** LM Studio 0.4.8+: `capabilities.reasoning` is `{ allowed_options, default }`. */
export function lmStudioReasoning(reasoning: unknown): ReasoningCapabilities {
  const details = record(reasoning)
  if (!details) return {}
  const levels = levelsFrom(details.allowed_options)
  return {
    supportsReasoning: true,
    reasoningLevels: levels,
    reasoningDefault: levelFrom(details.default)
  }
}

/**
 * OpenRouter's `reasoning`: `supported_efforts` (null for every effort, absent for none),
 * `mandatory` when reasoning cannot be turned off, and the defaults.
 */
export function openRouterReasoning(reasoning: unknown): ReasoningCapabilities {
  const details = record(reasoning)
  if (!details) return {}
  const efforts =
    details.supported_efforts === null
      ? [...EFFORTS]
      : (levelsFrom(details.supported_efforts)?.filter((level) => level !== 'off') ?? ['on'])
  const levels = details.mandatory === true ? efforts : ['off' as const, ...efforts]
  const reasoningDefault =
    details.default_enabled === false
      ? 'off'
      : (levelFrom(details.default_effort) ?? (efforts.includes('on') ? 'on' : undefined))
  return {
    supportsReasoning: true,
    reasoningLevels: REASONING_INTENSITY.filter((level) => levels.includes(level)),
    reasoningDefault
  }
}

/** Ollama's `/api/show` `thinking`: `{ values, default }`, where `[false]` means it cannot think. */
export function ollamaReasoning(thinking: unknown): ReasoningCapabilities {
  const details = record(thinking)
  const levels = levelsFrom(details?.values)
  if (!levels) return {}
  return {
    supportsReasoning: levels.some((level) => level !== 'off'),
    reasoningLevels: levels,
    reasoningDefault: levelFrom(details?.default)
  }
}

/**
 * Anthropic's `capabilities`: `thinking.types` says whether thinking can be turned off and whether
 * it takes a token budget; `effort` lists each effort level the model accepts.
 */
export function anthropicReasoning(capabilities: unknown): ReasoningCapabilities {
  const thinking = record(record(capabilities)?.thinking)
  if (!thinking) return {}
  if (thinking.supported !== true) return { supportsReasoning: false, reasoningLevels: [] }
  const types = record(thinking.types)
  const effort = record(record(capabilities)?.effort)
  // Without the details, the model's name says which kind of thinking it takes.
  if (!types && !effort) return { supportsReasoning: true }
  const levels: ReasoningLevel[] = types && !supported(types.disabled) ? [] : ['off']
  if (effort?.supported === true) {
    levels.push(...EFFORTS.filter((level) => supported(effort[level])))
  } else if (!types || supported(types.enabled)) {
    // A token budget, which SideKick sizes from the level.
    levels.push('low', 'medium', 'high')
  } else {
    levels.push('on')
  }
  return { supportsReasoning: true, reasoningLevels: levels }
}

/**
 * LiteLLM's model info: `supports_reasoning`, then `reasoning_effort_levels` where a deployment
 * sets them, else one flag per effort beyond the common low, medium and high.
 */
export function liteLLMReasoning(info: Record<string, unknown>): ReasoningCapabilities {
  if (typeof info.supports_reasoning !== 'boolean') return {}
  if (!info.supports_reasoning) return { supportsReasoning: false, reasoningLevels: [] }
  const listed = levelsFrom(info.reasoning_effort_levels)
  const flagged: ReasoningLevel[] = ['low', 'medium', 'high']
  for (const level of ['minimal', 'xhigh', 'max'] as const) {
    if (info[`supports_${level}_reasoning_effort`] === true) flagged.push(level)
  }
  const levels = new Set<ReasoningLevel>(listed?.length ? listed : flagged)
  if (info.thinking_always_on === true) levels.delete('off')
  else levels.add('off')
  return {
    supportsReasoning: true,
    reasoningLevels: REASONING_INTENSITY.filter((level) => levels.has(level)),
    reasoningDefault: levelFrom(info.default_reasoning_effort)
  }
}

/**
 * llama.cpp's `/props`. A template that reads `reasoning_effort` takes effort levels; one that
 * reads `enable_thinking` turns thinking on or off; any other cannot be changed per request.
 */
export function llamaCppReasoning(props: unknown): ReasoningCapabilities {
  const details = record(props)
  const template = typeof details?.chat_template === 'string' ? details.chat_template : undefined
  const caps = record(details?.chat_template_caps)
  if (!template && !caps) return {}
  if (caps?.supports_reasoning_effort === true || template?.includes('reasoning_effort'))
    return { supportsReasoning: true, reasoningLevels: ['off', 'low', 'medium', 'high'] }
  if (template?.includes('enable_thinking'))
    return { supportsReasoning: true, reasoningLevels: ['off', 'on'], reasoningDefault: 'on' }
  return { reasoningLevels: [] }
}
