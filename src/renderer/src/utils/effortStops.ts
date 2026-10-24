import type { ReasoningLevel } from '../../../shared/reasoning'

/** From the least reasoning to the most; "auto" is the model's own choice, not a step. */
const INTENSITY: readonly ReasoningLevel[] = [
  'off',
  'on',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

/** A model's levels as slider stops, least first. */
export function effortStops(levels: readonly ReasoningLevel[]): ReasoningLevel[] {
  return INTENSITY.filter((level) => levels.includes(level))
}
