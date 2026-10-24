import { describe, expect, it } from 'vitest'
import { installWindowZoom, zoomActionForInput, type TextScaleSetting } from './windowZoom'

const input = (
  key: string,
  code: string,
  extra: Partial<Parameters<typeof zoomActionForInput>[0]> = {}
) => ({
  type: 'keyDown' as const,
  control: true,
  meta: false,
  alt: false,
  key,
  code,
  ...extra
})

function fakeWindow() {
  const handlers: Record<string, (...args: unknown[]) => void> = {}
  const window = {
    zoom: 1,
    isDestroyed: () => false,
    on: () => undefined,
    webContents: {
      setZoomFactor: (value: number) => {
        window.zoom = value
      },
      on: (name: string, handler: (...args: unknown[]) => void) => {
        handlers[name] = handler
      }
    },
    load() {
      handlers['did-finish-load']()
    },
    press(key: string, code: string) {
      let prevented = false
      handlers['before-input-event']({ preventDefault: () => (prevented = true) }, input(key, code))
      return prevented
    }
  }
  return window
}

function fakeSetting(initial: unknown): TextScaleSetting & { value: unknown } {
  const listeners = new Set<() => void>()
  const setting = {
    value: initial,
    current: () => setting.value,
    save: (scale: number) => {
      setting.value = scale
      for (const listener of listeners) listener()
    },
    onChanged: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return setting
}

describe('window zoom shortcuts', () => {
  it('supports conventional keyboard and numpad shortcuts', () => {
    expect(zoomActionForInput(input('+', 'Equal'))).toBe('in')
    expect(zoomActionForInput(input('-', 'Minus'))).toBe('out')
    expect(zoomActionForInput(input('0', 'Digit0'))).toBe('reset')
    expect(zoomActionForInput(input('Add', 'NumpadAdd'))).toBe('in')
  })

  it('starts fresh installs at 100%, which the design draws at 90% of Chromium’s size', () => {
    const window = fakeWindow()
    installWindowZoom(window as never, fakeSetting(undefined))
    expect(window.zoom).toBe(0.9)
  })

  it('puts the setting back over the zoom Chromium restores for the page’s host', () => {
    const window = fakeWindow()
    installWindowZoom(window as never, fakeSetting(120))
    window.zoom = 0.8
    window.load()
    expect(window.zoom).toBe(1.08)
  })

  it('steps the text-size setting, so the shortcuts and Settings can never stack', () => {
    const window = fakeWindow()
    const setting = fakeSetting(100)
    installWindowZoom(window as never, setting)

    expect(window.press('+', 'Equal')).toBe(true)
    expect(setting.value).toBe(110)
    expect(window.zoom).toBe(0.99)
    window.press('-', 'Minus')
    window.press('-', 'Minus')
    expect(setting.value).toBe(90)

    // Settings choosing a size moves the window there too.
    setting.save(135)
    expect(window.zoom).toBe(1.215)
    window.press('0', 'Digit0')
    expect(setting.value).toBe(100)
    expect(window.zoom).toBe(0.9)
  })

  it('stops at the smallest and largest sizes', () => {
    const window = fakeWindow()
    const setting = fakeSetting(150)
    installWindowZoom(window as never, setting)
    window.press('+', 'Equal')
    expect(setting.value).toBe(150)
    setting.save(80)
    window.press('-', 'Minus')
    expect(setting.value).toBe(80)
  })

  it('does not capture unmodified or Alt-modified keys', () => {
    expect(zoomActionForInput(input('+', 'Equal', { control: false }))).toBeNull()
    expect(zoomActionForInput(input('+', 'Equal', { alt: true }))).toBeNull()
  })
})
