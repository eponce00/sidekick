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
  // One pass over the characters. The main process estimates the whole transcript before every
  // model request, and splitting it into a string per word made that cost tens of milliseconds
  // per megabyte of blocked window.
  let lexicalEstimate = 0
  let index = 0
  while (index < content.length) {
    const code = content.charCodeAt(index)
    if (isWordCharacter(code) || isDigit(code)) {
      // Letters count a token per four, digits a token per three.
      const inRun = isDigit(code) ? isDigit : isWordCharacter
      const start = index
      while (index < content.length && inRun(content.charCodeAt(index))) index++
      lexicalEstimate += Math.ceil((index - start) / (inRun === isDigit ? 3 : 4))
    } else if (isWhitespace(code)) {
      index++
    } else {
      // Any other code point is a token of its own; a surrogate pair is one code point.
      const pair =
        code >= 0xd800 &&
        code <= 0xdbff &&
        index + 1 < content.length &&
        content.charCodeAt(index + 1) >= 0xdc00 &&
        content.charCodeAt(index + 1) <= 0xdfff
      index += pair ? 2 : 1
      lexicalEstimate++
    }
  }
  return Math.max(proseEstimate, lexicalEstimate)
}

/** `[A-Za-z_]` */
function isWordCharacter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
}

/** `\d`, which is ASCII only. */
function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

/** `\s`: ECMAScript white space and line terminators. */
function isWhitespace(code: number): boolean {
  return (
    (code >= 9 && code <= 13) ||
    code === 32 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  )
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

/**
 * The most a conversation keeps free for the next reply. A larger reply limit is a ceiling a long
 * answer may reach, not room every request holds back: each request's limit shrinks to the room
 * actually left, so holding back more would only summarize chats long before their window fills.
 */
export const MAX_RESERVED_REPLY_TOKENS = 32_768

/**
 * Shared capacity math used by both the runtime guard and its user-facing indicator. The
 * compaction threshold is the share of the whole window a chat may fill, as Settings describes
 * it, and never so much that the reply's room and the safety margin no longer fit.
 */
export function calculateContextCapacity(options: {
  contextLength: number
  reservedOutputTokens: number
  compactionThreshold: number
}): ContextCapacity {
  const contextLength = Math.max(1_024, Math.floor(options.contextLength))
  const safetyMarginTokens = Math.max(256, Math.floor(contextLength * 0.02))
  const reservedOutputTokens = Math.min(
    Math.max(256, Math.floor(Math.min(options.reservedOutputTokens, MAX_RESERVED_REPLY_TOKENS))),
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
    compactionTriggerTokens: Math.max(
      256,
      Math.min(effectiveInputLimit, Math.round(contextLength * threshold))
    )
  }
}

/**
 * How long the next reply may be: the model's reply limit, cut to what the window has left after
 * the request and the safety margin. Asking for more than fits makes some servers refuse the
 * request outright.
 */
export function replyLimitForRequest(
  maxOutputTokens: number | undefined,
  budget: Pick<RequestBudget, 'contextLength' | 'safetyMarginTokens' | 'requestTokens'>
): number | undefined {
  if (maxOutputTokens === undefined) return undefined
  const room = budget.contextLength - budget.safetyMarginTokens - budget.requestTokens
  return Math.max(1_024, Math.min(maxOutputTokens, Math.floor(room)))
}

/**
 * How long one reply may be. Without a configured maximum, a quarter of the context window up to
 * 32,768 tokens, and no more than the most the provider's catalog says the model can write. A
 * configured maximum is the user's own and is honored up to half the window, so the conversation
 * keeps room; a reasoning model needs it to think through a large task. A catalog's maximum only
 * lowers the default: reserving all a model could write would shrink every chat's room.
 */
export function resolveMaxOutputTokens(
  contextLength: number,
  configuredMaxOutputTokens?: number,
  outputTokenLimit?: number
): number {
  const normalizedContext = Math.max(1_024, Math.floor(contextLength))
  if (
    configuredMaxOutputTokens === undefined ||
    !Number.isFinite(configuredMaxOutputTokens) ||
    configuredMaxOutputTokens <= 0
  ) {
    const budget = Math.max(1_024, Math.min(32_768, Math.floor(normalizedContext / 4)))
    return outputTokenLimit && Number.isFinite(outputTokenLimit) && outputTokenLimit > 0
      ? Math.min(budget, Math.floor(outputTokenLimit))
      : budget
  }
  return Math.max(
    1_024,
    Math.min(Math.floor(normalizedContext / 2), Math.floor(configuredMaxOutputTokens))
  )
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

/**
 * The least share of SideKick's own estimate a calibration may bring a request down to. The
 * estimate counts punctuation one by one, which real tokenizers merge, so a local model's real
 * prompt ran 20–40% under it; a correction past half would come from a request unlike this one.
 */
export const MIN_CALIBRATED_ESTIMATE_SHARE = 0.5

/**
 * An estimate corrected by what the provider really counted for an earlier request: the real count
 * of what was already sent, plus the estimate of what was added since. The correction goes either
 * way, within a floor, so an estimate that runs high no longer compacts a chat early.
 */
export function calibratedRequestTokens(estimatedTokens: number, biasTokens = 0): number {
  const bias = Number.isFinite(biasTokens) ? Math.round(biasTokens) : 0
  return Math.max(
    Math.ceil(estimatedTokens * MIN_CALIBRATED_ESTIMATE_SHARE),
    estimatedTokens + bias
  )
}

export function calculateRequestBudget(options: {
  messages: ProviderChatMessage[]
  tools: readonly unknown[]
  contextLength: number
  reservedOutputTokens: number
  compactionThreshold: number
  inFlightCharacters?: number
  /**
   * The provider's real prompt count minus SideKick's estimate for an earlier request, positive
   * when the provider counted more.
   */
  estimationBiasTokens?: number
}): RequestBudget {
  const capacity = calculateContextCapacity(options)
  const breakdown = providerRequestTokenBreakdown(
    options.messages,
    options.tools,
    options.inFlightCharacters
  )
  const requestTokens = calibratedRequestTokens(
    breakdown.requestTokens,
    options.estimationBiasTokens
  )

  return {
    ...breakdown,
    requestTokens,
    ...capacity,
    remainingInputTokens: capacity.effectiveInputLimit - requestTokens,
    utilization: requestTokens / capacity.effectiveInputLimit,
    shouldCompact: requestTokens >= capacity.compactionTriggerTokens
  }
}
