import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate, type ApplicationMenuActions } from './applicationMenu'

function actions(): ApplicationMenuActions {
  return {
    'open-settings': vi.fn(),
    'new-chat': vi.fn(),
    'open-project': vi.fn(),
    'check-for-updates': vi.fn(),
    'text-larger': vi.fn(),
    'text-smaller': vi.fn(),
    'text-reset': vi.fn()
  }
}

describe('applicationMenuTemplate', () => {
  it('steps the text-size setting instead of offering Chromium zoom', () => {
    const menuActions = actions()
    const template = applicationMenuTemplate('win32', 'SideKick', menuActions)
    const view = (template.find(({ label }) => label === 'View')?.submenu ||
      []) as MenuItemConstructorOptions[]
    // Chromium's own zoom would stack with the text-size setting.
    expect(view.some(({ role }) => role === 'zoomIn' || role === 'resetZoom')).toBe(false)
    ;(view.find(({ label }) => label === 'Larger Text')?.click as () => void)()
    expect(menuActions['text-larger']).toHaveBeenCalledOnce()
  })
})
