import type { TokenUsage } from '../types/chat.types'

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Reads the canonical provider usage envelope persisted with agent-session records. */
export function messageTokenUsageFromMetadata(
  metadata: Record<string, unknown> | undefined
): TokenUsage | undefined {
  if (!metadata) return undefined
  const nested =
    metadata.usage && typeof metadata.usage === 'object'
      ? (metadata.usage as Record<string, unknown>)
      : metadata
  const promptTokens = finiteNonNegative(nested.promptTokens)
  const completionTokens = finiteNonNegative(nested.completionTokens)
  const cachedPromptTokens = finiteNonNegative(nested.cachedPromptTokens)
  const tokensPerSecond = finiteNonNegative(nested.tokensPerSecond)
  const timeToFirstTokenMs = finiteNonNegative(nested.timeToFirstTokenMs)
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    cachedPromptTokens === undefined &&
    tokensPerSecond === undefined &&
    timeToFirstTokenMs === undefined
  ) {
    return undefined
  }
  return {
    promptTokens: promptTokens ?? 0,
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
    completionTokens: completionTokens ?? 0,
    ...(tokensPerSecond !== undefined && tokensPerSecond > 0 ? { tokensPerSecond } : {}),
    ...(timeToFirstTokenMs === undefined ? {} : { timeToFirstTokenMs })
  }
}

export function mergeMessageTokenUsage(
  left: TokenUsage | undefined,
  right: TokenUsage | undefined
): TokenUsage | undefined {
  if (!left) return right
  if (!right) return left
  const measured = [left, right].filter(
    (usage) => (usage.tokensPerSecond ?? 0) > 0 && usage.completionTokens > 0
  )
  const measuredTokens = measured.reduce((total, usage) => total + usage.completionTokens, 0)
  const measuredSeconds = measured.reduce(
    (total, usage) => total + usage.completionTokens / usage.tokensPerSecond!,
    0
  )
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    ...((left.cachedPromptTokens ?? 0) + (right.cachedPromptTokens ?? 0) > 0
      ? { cachedPromptTokens: (left.cachedPromptTokens ?? 0) + (right.cachedPromptTokens ?? 0) }
      : {}),
    completionTokens: left.completionTokens + right.completionTokens,
    ...((left.cost ?? 0) + (right.cost ?? 0) > 0
      ? { cost: (left.cost ?? 0) + (right.cost ?? 0) }
      : {}),
    ...(measuredSeconds > 0 ? { tokensPerSecond: measuredTokens / measuredSeconds } : {}),
    ...(left.timeToFirstTokenMs !== undefined
      ? { timeToFirstTokenMs: left.timeToFirstTokenMs }
      : right.timeToFirstTokenMs !== undefined
        ? { timeToFirstTokenMs: right.timeToFirstTokenMs }
        : {})
  }
}
