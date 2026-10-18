import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions, WebContents } from 'electron'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })) }
}))

import { chooseAppMenuItem, dismissAppMenu, showAppMenu } from './appMenus'
import type { AppMenuRequest } from '../../shared/appMenus'

function fakeContents(id: number): WebContents & { sent: AppMenuRequest[] } {
  const sent: AppMenuRequest[] = []
  return {
    id,
    sent,
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    send: (_channel: string, request: AppMenuRequest) => sent.push(request),
    copy: vi.fn(),
    paste: vi.fn()
  } as unknown as WebContents & { sent: AppMenuRequest[] }
}

describe('SideKick-drawn menus', () => {
  let contents: ReturnType<typeof fakeContents>

  beforeEach(() => {
    contents = fakeContents(1)
  })

  it('sends a plain description of the menu, and keeps every action in the main process', () => {
    const reveal = vi.fn()
    const template: MenuItemConstructorOptions[] = [
      { label: 'Show in Folder', accelerator: 'CommandOrControl+R', click: reveal },
      { type: 'separator' },
      { label: 'Sizes', enabled: false },
      { label: 'Phone', type: 'checkbox', checked: true, click: vi.fn() },
      { label: 'Open with', submenu: [{ label: 'Default app', click: vi.fn() }] },
      { role: 'copy', enabled: false }
    ]
    expect(showAppMenu(contents, template, { x: 10, y: 20 })).toBe(true)
    const [request] = contents.sent
    expect(request).toMatchObject({ x: 10, y: 20 })
    expect(JSON.parse(JSON.stringify(request.items))).toEqual(request.items)
    expect(request.items.map(({ type, label }) => [type, label ?? null])).toEqual([
      ['normal', 'Show in Folder'],
      ['separator', null],
      ['heading', 'Sizes'],
      ['checkbox', 'Phone'],
      ['submenu', 'Open with'],
      ['normal', 'Copy']
    ])
    expect(request.items[3].checked).toBe(true)
    expect(request.items[5].enabled).toBe(false)
    expect(request.items[0].shortcut).toMatch(/R$/)

    chooseAppMenuItem(contents, request.token, request.items[0].id)
    expect(reveal).toHaveBeenCalledOnce()
    // The token is spent: choosing again does nothing.
    chooseAppMenuItem(contents, request.token, request.items[0].id)
    expect(reveal).toHaveBeenCalledOnce()
  })

  it('performs edit roles on the window that asked, and only for that window', () => {
    expect(showAppMenu(contents, [{ role: 'paste' }], { x: 0, y: 0 })).toBe(true)
    const [request] = contents.sent
    chooseAppMenuItem(fakeContents(2), request.token, request.items[0].id)
    expect(contents.paste).not.toHaveBeenCalled()
    chooseAppMenuItem(contents, request.token, request.items[0].id)
    expect(contents.paste).toHaveBeenCalledOnce()
  })

  it('leaves menus with system-only items to the native menu', () => {
    expect(showAppMenu(contents, [{ role: 'services' }], { x: 0, y: 0 })).toBe(false)
    expect(
      showAppMenu(contents, [{ label: 'Speech', submenu: [{ role: 'startSpeaking' }] }], {
        x: 0,
        y: 0
      })
    ).toBe(false)
    expect(contents.sent).toEqual([])
  })

  it('tells whoever opened it when the menu closes without a choice', () => {
    const onClose = vi.fn()
    showAppMenu(contents, [{ label: 'One', click: vi.fn() }], { x: 0, y: 0 }, onClose)
    dismissAppMenu(fakeContents(2), contents.sent[0].token)
    expect(onClose).not.toHaveBeenCalled()
    dismissAppMenu(contents, contents.sent[0].token)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
