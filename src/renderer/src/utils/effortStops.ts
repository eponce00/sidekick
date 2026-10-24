import { REASONING_INTENSITY, type ReasoningLevel } from '../../../shared/reasoning'

/** A model's levels as slider stops, least first. */
export function effortStops(levels: readonly ReasoningLevel[]): ReasoningLevel[] {
  return REASONING_INTENSITY.filter((level) => levels.includes(level))
}
