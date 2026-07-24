import { describe, expect, it, vi } from 'vitest'
import { windowsTitleBarMenuTemplate, type WindowMenuActions } from './windowsTitleBarMenu'

function actions(): WindowMenuActions {
  return {
    restore: vi.fn(),
    minimize: vi.fn(),
    maximize: vi.fn(),
    close: vi.fn()
  }
}

describe('windowsTitleBarMenuTemplate', () => {
  it('offers the conventional restore, minimize, maximize, and close commands', () => {
    const template = windowsTitleBarMenuTemplate({ minimized: false, maximized: false }, actions())
    expect(template.map(({ label, type }) => label || type)).toEqual([
      'Restore',
      'Minimize',
      'Maximize',
      'separator',
      'Close'
    ])
    expect(template[0].enabled).toBe(false)
    expect(template[1].enabled).toBe(true)
    expect(template[2].enabled).toBe(true)
    expect(template[4].accelerator).toBe('Alt+F4')
  })

  it('enables restore and disables maximize for a maximized window', () => {
    const template = windowsTitleBarMenuTemplate({ minimized: false, maximized: true }, actions())
    expect(template[0].enabled).toBe(true)
    expect(template[2].enabled).toBe(false)
  })
})
