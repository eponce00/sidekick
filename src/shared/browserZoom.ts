/** A page's zoom in the Browser panel, in percent, in the steps Chrome uses. */
export const BROWSER_ZOOM_LEVELS: readonly number[] = [
  50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300
]
export const DEFAULT_BROWSER_ZOOM = 100

export type BrowserZoomStep = 'in' | 'out' | 'reset'

export function isBrowserZoomStep(value: unknown): value is BrowserZoomStep {
  return value === 'in' || value === 'out' || value === 'reset'
}

/** The zoom one step on from `current`, staying within the levels. */
export function steppedBrowserZoom(current: number, step: BrowserZoomStep): number {
  if (step === 'reset') return DEFAULT_BROWSER_ZOOM
  const nearest = BROWSER_ZOOM_LEVELS.reduce((best, level) =>
    Math.abs(level - current) < Math.abs(best - current) ? level : best
  )
  const index = BROWSER_ZOOM_LEVELS.indexOf(nearest) + (step === 'in' ? 1 : -1)
  return BROWSER_ZOOM_LEVELS[Math.max(0, Math.min(BROWSER_ZOOM_LEVELS.length - 1, index))]
}
