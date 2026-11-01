/** How much of each part of a large JSON value an outline keeps. */
export interface JsonOutlineLimits {
  /** Items kept at the start of each list. */
  items: number
  /** Characters kept at the start of each text. */
  chars: number
  /** Keys kept in each object, in their order. */
  keys: number
}

/** From the fullest outline to the barest, tried in turn until one fits. */
export const JSON_OUTLINE_STEPS: readonly JsonOutlineLimits[] = [
  { items: 60, chars: 400, keys: 80 },
  { items: 40, chars: 400, keys: 80 },
  { items: 25, chars: 300, keys: 80 },
  { items: 15, chars: 300, keys: 80 },
  { items: 10, chars: 300, keys: 80 },
  { items: 5, chars: 300, keys: 80 },
  { items: 3, chars: 200, keys: 50 },
  { items: 2, chars: 120, keys: 30 },
  { items: 1, chars: 60, keys: 20 }
]

const count = (value: number): string => value.toLocaleString('en-US')

/**
 * A JSON value with its long parts cut and marked: each list keeps its first items and says how
 * many more there are, each long text keeps its start, and an object with very many keys keeps the
 * first ones. Every other key and short value stays, so a field such as a token is never lost
 * because it sorts after a long list, as cutting the text at a byte loses it.
 */
export function outlineJson(value: unknown, limits: JsonOutlineLimits): unknown {
  if (typeof value === 'string')
    return value.length > limits.chars
      ? `${value.slice(0, limits.chars)}… (${count(value.length - limits.chars)} more characters)`
      : value
  if (Array.isArray(value)) {
    const kept = value.slice(0, limits.items).map((item) => outlineJson(item, limits))
    return value.length > limits.items
      ? [...kept, `… ${count(value.length - limits.items)} more items`]
      : kept
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    const kept = entries
      .slice(0, limits.keys)
      .map(([key, item]) => [key, outlineJson(item, limits)] as const)
    return Object.fromEntries(
      entries.length > limits.keys
        ? [...kept, ['…', `${count(entries.length - limits.keys)} more keys`]]
        : kept
    )
  }
  return value
}

/** The fullest outline of `value` whose JSON `fits`, with the limits it used; null if none does. */
export function fittingOutline(
  value: unknown,
  fits: (outlined: unknown) => boolean
): { outline: unknown; limits: JsonOutlineLimits } | null {
  if (!value || typeof value !== 'object') return null
  for (const limits of JSON_OUTLINE_STEPS) {
    const outline = outlineJson(value, limits)
    if (fits(outline)) return { outline, limits }
  }
  return null
}
