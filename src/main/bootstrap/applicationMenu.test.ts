import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate, type ApplicationMenuActions } from './applicationMenu'

function actions(): ApplicationMenuActions {
  return {
    'open-settings': vi.fn(),
    'new-chat': vi.fn(),
    'open-project': vi.fn(),
    'check-for-updates': vi.fn()
  }
}

function submenu(item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] {
  return (item?.submenu || []) as MenuItemConstructorOptions[]
}

describe('applicationMenuTemplate', () => {
  it('uses the conventional macOS app menu and shortcuts', () => {
    const template = applicationMenuTemplate('darwin', 'SideKick', actions())
    expect(template[0].label).toBe('SideKick')
    expect(submenu(template[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'about' }),
        expect.objectContaining({ label: 'Settings…', accelerator: 'Command+,' }),
        expect.objectContaining({ label: 'Check for Updates…' }),
        expect.objectContaining({ role: 'services' }),
        expect.objectContaining({ role: 'quit' })
      ])
    )
    expect(submenu(template.find(({ label }) => label === 'File'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'New Chat', accelerator: 'CmdOrCtrl+N' }),
        expect.objectContaining({ label: 'Open Project…', accelerator: 'CmdOrCtrl+O' }),
        expect.objectContaining({ role: 'close' })
      ])
    )
  })

  it('provides an intentional Windows menu instead of Electron defaults', () => {
    const template = applicationMenuTemplate('win32', 'SideKick', actions())
    expect(template.map(({ label, role }) => label || role)).toEqual([
      'File',
      'editMenu',
      'View',
      'windowMenu',
      'Help'
    ])
    expect(submenu(template[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Settings…', accelerator: 'Ctrl+,' }),
        expect.objectContaining({ role: 'quit' })
      ])
    )
    expect(submenu(template.find(({ label }) => label === 'View'))).toEqual([
      expect.objectContaining({ role: 'togglefullscreen', accelerator: 'F11' })
    ])
    expect(submenu(template.find(({ label }) => label === 'Help'))).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Check for Updates…' })])
    )
  })
})
