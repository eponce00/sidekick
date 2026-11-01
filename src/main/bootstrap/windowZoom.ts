import type { BrowserWindow, Input } from 'electron'
import { steppedTextScale, zoomForTextScale, type TextScaleStep } from '../../shared/textScale'

/** The text-size setting, which the window's zoom always follows. */
export interface TextScaleSetting {
  current(): unknown
  save(scale: number): void
  onChanged(listener: () => void): () => void
}

export function zoomActionForInput(
  input: Pick<Input, 'type' | 'control' | 'meta' | 'alt' | 'key' | 'code'>
): TextScaleStep | null {
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

export function stepTextScale(setting: TextScaleSetting, step: TextScaleStep): void {
  setting.save(steppedTextScale(setting.current(), step))
}

/**
 * Sizes the window from the text-size setting. Zoom shortcuts change that setting rather than
 * Chromium's zoom, so the shortcuts and Settings can never stack.
 */
export function installWindowZoom(window: BrowserWindow, setting: TextScaleSetting): void {
  const apply = (): void => {
    if (!window.isDestroyed()) window.webContents.setZoomFactor(zoomForTextScale(setting.current()))
  }
  apply()
  // Chromium keeps a zoom per host and restores it when a page loads, over the one set above.
  window.webContents.on('did-finish-load', apply)
  const stop = setting.onChanged(apply)
  window.on('closed', stop)
  window.webContents.on('before-input-event', (event, input) => {
    const step = zoomActionForInput(input)
    if (!step) return
    event.preventDefault()
    stepTextScale(setting, step)
  })
}
