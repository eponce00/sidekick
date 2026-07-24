import type { ProviderChatMessage } from './providerRuntime'

const PROVIDER_FRAMING_TOKENS = 256

/**
 * Conservative provider-agnostic token estimate.
 *
 * A flat characters/4 estimate is acceptable for prose, but badly undercounts
 * minified JSON, numeric arrays, stack traces, and escaped command output. The
 * lexical estimate intentionally treats structural punctuation as individual
 * tokens and numeric runs as groups of at most three digits. Providers may
 * merge some of these pieces, so this is a safety estimate rather than billing
 * telemetry.
 */
export function estimateTextTokens(content: string): number {
  if (!content) return 0
  const proseEstimate = Math.ceil(content.length / 4)
  let lexicalEstimate = 0
  for (const part of content.match(/\s+|[A-Za-z_]+|\d+|[^\sA-Za-z_\d]/gu) ?? []) {
    if (/^\s+$/u.test(part)) continue
    if (/^[A-Za-z_]+$/u.test(part)) lexicalEstimate += Math.ceil(part.length / 4)
    else if (/^\d+$/u.test(part)) lexicalEstimate += Math.ceil(part.length / 3)
    else lexicalEstimate += Array.from(part).length
  }
  return Math.max(proseEstimate, lexicalEstimate)
}

export interface ProviderRequestTokenBreakdown {
  messageTokens: number
  toolSchemaTokens: number
  providerFramingTokens: number
  inFlightTokens: number
  requestTokens: number
}

export interface RequestBudget extends ProviderRequestTokenBreakdown {
  contextLength: number
  reservedOutputTokens: number
  safetyMarginTokens: number
  effectiveInputLimit: number
  compactionTriggerTokens: number
  remainingInputTokens: number
  utilization: number
  shouldCompact: boolean
}

export interface ContextCapacity {
  contextLength: number
  reservedOutputTokens: number
  safetyMarginTokens: number
  effectiveInputLimit: number
  compactionTriggerTokens: number
}

/** Shared capacity math used by both the runtime guard and its user-facing indicator. */
export function calculateContextCapacity(options: {
  contextLength: number
  reservedOutputTokens: number
  compactionThreshold: number
}): ContextCapacity {
  const contextLength = Math.max(1_024, Math.floor(options.contextLength))
  const safetyMarginTokens = Math.max(256, Math.floor(contextLength * 0.02))
  const reservedOutputTokens = Math.min(
    Math.max(256, Math.floor(options.reservedOutputTokens)),
    Math.max(256, contextLength - safetyMarginTokens - 512)
  )
  const effectiveInputLimit = Math.max(
    256,
    contextLength - reservedOutputTokens - safetyMarginTokens
  )
  const threshold = Math.min(0.98, Math.max(0.1, options.compactionThreshold))
  return {
    contextLength,
    reservedOutputTokens,
    safetyMarginTokens,
    effectiveInputLimit,
    compactionTriggerTokens: Math.max(256, Math.floor(effectiveInputLimit * threshold))
  }
}

export function resolveMaxOutputTokens(
  contextLength: number,
  configuredMaxOutputTokens?: number
): number {
  const normalizedContext = Math.max(1_024, Math.floor(contextLength))
  const derived = Math.max(1_024, Math.min(32_768, Math.floor(normalizedContext / 4)))
  if (
    configuredMaxOutputTokens === undefined ||
    !Number.isFinite(configuredMaxOutputTokens) ||
    configuredMaxOutputTokens <= 0
  ) {
    return derived
  }
  return Math.max(1_024, Math.min(derived, Math.floor(configuredMaxOutputTokens)))
}

function estimateImageTokens(image: string): number {
  if (/^https?:/i.test(image)) return 768
  // Image payloads are encoded by multimodal providers rather than tokenized as
  // literal base64. This bounded estimate is intentionally conservative without
  // treating a one-megabyte image as hundreds of thousands of language tokens.
  return Math.min(8_192, Math.max(512, Math.ceil(image.length / 256)))
}

export function estimateConversationTokens(messages: ProviderChatMessage[]): number {
  return messages.reduce((sum, message) => {
    const contentTokens = estimateTextTokens(message.content || '')
    const toolCallTokens = message.tool_calls
      ? estimateTextTokens(JSON.stringify(message.tool_calls))
      : 0
    const imageTokens = (message.images || []).reduce(
      (imageSum, image) => imageSum + estimateImageTokens(image),
      0
    )
    return sum + contentTokens + toolCallTokens + imageTokens + 4
  }, 0)
}

export function estimateToolSchemaTokens(tools: readonly unknown[]): number {
  try {
    return estimateTextTokens(JSON.stringify(tools))
  } catch {
    return 0
  }
}

export function estimateProviderRequestTokens(
  messages: ProviderChatMessage[],
  tools: readonly unknown[],
  inFlightCharacters = 0
): number {
  return providerRequestTokenBreakdown(messages, tools, inFlightCharacters).requestTokens
}

export function providerRequestTokenBreakdown(
  messages: ProviderChatMessage[],
  tools: readonly unknown[],
  inFlightCharacters = 0
): ProviderRequestTokenBreakdown {
  const messageTokens = estimateConversationTokens(messages)
  const toolSchemaTokens = estimateToolSchemaTokens(tools)
  const inFlightTokens = Math.ceil(Math.max(0, inFlightCharacters) / 4)
  return {
    messageTokens,
    toolSchemaTokens,
    providerFramingTokens: PROVIDER_FRAMING_TOKENS,
    inFlightTokens,
    requestTokens: messageTokens + toolSchemaTokens + PROVIDER_FRAMING_TOKENS + inFlightTokens
  }
}

export function calculateRequestBudget(options: {
  messages: ProviderChatMessage[]
  tools: readonly unknown[]
  contextLength: number
  reservedOutputTokens: number
  compactionThreshold: number
  inFlightCharacters?: number
  /** Positive correction learned from the provider's latest actual prompt usage. */
  estimationBiasTokens?: number
}): RequestBudget {
  const capacity = calculateContextCapacity(options)
  const breakdown = providerRequestTokenBreakdown(
    options.messages,
    options.tools,
    options.inFlightCharacters
  )
  const requestTokens =
    breakdown.requestTokens + Math.max(0, Math.ceil(options.estimationBiasTokens ?? 0))

  return {
    ...breakdown,
    requestTokens,
    ...capacity,
    remainingInputTokens: capacity.effectiveInputLimit - requestTokens,
    utilization: requestTokens / capacity.effectiveInputLimit,
    shouldCompact: requestTokens >= capacity.compactionTriggerTokens
  }
}
