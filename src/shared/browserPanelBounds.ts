import type { BrowserPanelBounds } from './browserWorkspace'

/** Intersect a layout snapshot with the current host; never mount an empty view. */
export function clipBrowserPanelBounds(
  bounds: BrowserPanelBounds,
  width: number,
  height: number
): BrowserPanelBounds | null {
  if (![bounds.x, bounds.y, bounds.width, bounds.height, width, height].every(Number.isFinite))
    return null
  if (bounds.width <= 0 || bounds.height <= 0 || width <= 0 || height <= 0) return null
  const x = Math.ceil(Math.max(0, bounds.x))
  const y = Math.ceil(Math.max(0, bounds.y))
  const right = Math.floor(Math.min(width, bounds.x + bounds.width))
  const bottom = Math.floor(Math.min(height, bounds.y + bounds.height))
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}
