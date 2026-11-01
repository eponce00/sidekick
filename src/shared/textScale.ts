/**
 * SideKick has one size control. Settings' Text size and Ctrl + / Ctrl − / Ctrl 0 step through the
 * same sizes and scale the whole window, so text and the interface around it grow together and
 * keep the proportions the design was drawn with.
 */
export const TEXT_SCALES: readonly number[] = [80, 90, 100, 110, 120, 135, 150]
export const DEFAULT_TEXT_SCALE = 100

/** The window zoom 100% stands for: the interface is designed at 90% of Chromium's own size. */
const DESIGN_ZOOM = 0.9

export type TextScaleStep = 'in' | 'out' | 'reset'

/** The size closest to `value`, so a size set from the command line still lands on a step. */
export function nearestTextScale(value: unknown): number {
  const wanted = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_TEXT_SCALE
  return TEXT_SCALES.reduce((best, scale) =>
    Math.abs(scale - wanted) < Math.abs(best - wanted) ? scale : best
  )
}

export function steppedTextScale(current: unknown, step: TextScaleStep): number {
  if (step === 'reset') return DEFAULT_TEXT_SCALE
  const index = TEXT_SCALES.indexOf(nearestTextScale(current)) + (step === 'in' ? 1 : -1)
  return TEXT_SCALES[Math.max(0, Math.min(TEXT_SCALES.length - 1, index))]
}

export function zoomForTextScale(scale: unknown): number {
  return Math.round(DESIGN_ZOOM * nearestTextScale(scale) * 10) / 1000
}

/**
 * The size that keeps what an earlier version showed: its window zoom times its separate
 * conversation text size, which was 13px by default.
 */
export function legacyTextScale(zoomFactor: unknown, contentFontSize: unknown): number {
  const zoom = typeof zoomFactor === 'number' && zoomFactor > 0 ? zoomFactor : DESIGN_ZOOM
  const fontSize = typeof contentFontSize === 'number' && contentFontSize > 0 ? contentFontSize : 13
  return nearestTextScale((zoom / DESIGN_ZOOM) * (fontSize / 13) * 100)
}
