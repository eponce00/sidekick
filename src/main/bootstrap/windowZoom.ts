import type { BrowserWindow, Input } from 'electron'

const ZOOM_STATE_KEY = 'desktopZoomFactorV1'
const MIN_ZOOM = 0.5
const MAX_ZOOM = 2
const ZOOM_STEP = 0.1
export const DEFAULT_ZOOM = 0.9

export type WindowZoomAction = 'in' | 'out' | 'reset'

function boundedZoom(value: number): number {
  return Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value)) * 10) / 10
}

export function zoomActionForInput(input: Pick<Input, 'type' | 'control' | 'meta' | 'alt' | 'key' | 'code'>): WindowZoomAction | null {
  if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta)) return null
  if (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0') return 'reset'
  if (
    input.key === '+' ||
    input.key === '=' ||
    input.code === 'Equal' ||
    input.code === 'NumpadAdd'
  )
    return 'in'
  if (input.key === '-' || input.code === 'Minus' || input.code === 'NumpadSubtract') return 'out'
  return null
}

export function applyWindowZoom(window: BrowserWindow, action: WindowZoomAction): number {
  const current = window.webContents.getZoomFactor()
  const next = boundedZoom(
    action === 'reset' ? DEFAULT_ZOOM : current + (action === 'in' ? ZOOM_STEP : -ZOOM_STEP)
  )
  window.webContents.setZoomFactor(next)
  return next
}

export function installWindowZoom(window: BrowserWindow, store?: { get(key: string): unknown; set(key: string, value: unknown): void }): void {
  const stored = Number(store?.get(ZOOM_STATE_KEY))
  window.webContents.setZoomFactor(
    Number.isFinite(stored) && stored > 0 ? boundedZoom(stored) : DEFAULT_ZOOM
  )
  window.webContents.on('before-input-event', (event, input) => {
    const action = zoomActionForInput(input)
    if (!action) return
    event.preventDefault()
    store?.set(ZOOM_STATE_KEY, applyWindowZoom(window, action))
  })
}
