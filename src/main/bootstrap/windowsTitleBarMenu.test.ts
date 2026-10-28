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
  it('enables restore only for a maximized window, and maximize only for a normal one', () => {
    const normal = windowsTitleBarMenuTemplate({ minimized: false, maximized: false }, actions())
    expect([normal[0].enabled, normal[2].enabled]).toEqual([false, true])
    const maximized = windowsTitleBarMenuTemplate({ minimized: false, maximized: true }, actions())
    expect([maximized[0].enabled, maximized[2].enabled]).toEqual([true, false])
  })
})
