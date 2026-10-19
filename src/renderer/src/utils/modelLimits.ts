import type { ProviderInstanceModel } from '../../../shared/settings'

/**
 * A token count as providers quote it: round numbers in decimal units (128,000 is "128K") and
 * powers of two in binary ones (131,072 is "128K").
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const [unit, decimal, binary] =
    tokens >= 1_000_000 ? ['M', 1_000_000, 1_048_576] : ['K', 1000, 1024]
  const value = tokens / (tokens % decimal !== 0 && tokens % binary === 0 ? binary : decimal)
  return `${value < 10 ? Number(value.toFixed(1)) : Math.round(value)}${unit}`
}

/** Per-token prices as dollars per million tokens, input then output. */
export function formatModelPrice(pricing: { prompt: number; completion: number }): string {
  if (pricing.prompt === 0 && pricing.completion === 0) return 'Free'
  const perMillion = (perToken: number): string => {
    const dollars = perToken * 1_000_000
    return `$${Number(dollars.toFixed(dollars < 1 ? 3 : 2))}`
  }
  return `${perMillion(pricing.prompt)}/${perMillion(pricing.completion)} per M`
}

/** A model's context window, output limit, and price, as one line. */
export function modelLimitsLabel(model: ProviderInstanceModel): string {
  const output = model.maxOutputTokens ?? model.outputTokenLimit
  return [
    model.contextLength ? `${formatTokenCount(model.contextLength)} context` : 'Context unknown',
    output ? `${formatTokenCount(output)} output` : undefined,
    model.pricing ? formatModelPrice(model.pricing) : undefined
  ]
    .filter(Boolean)
    .join(' · ')
}
