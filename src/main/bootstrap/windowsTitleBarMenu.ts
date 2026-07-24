import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

export const WINDOWS_TITLE_BAR_HEIGHT = 42

export interface WindowMenuState {
  minimized: boolean
  maximized: boolean
}

export interface WindowMenuActions {
  restore: () => void
  minimize: () => void
  maximize: () => void
  close: () => void
}

export function windowsTitleBarMenuTemplate(
  state: WindowMenuState,
  actions: WindowMenuActions
): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Restore',
      enabled: state.minimized || state.maximized,
      click: actions.restore
    },
    { label: 'Minimize', enabled: !state.minimized, click: actions.minimize },
    { label: 'Maximize', enabled: !state.maximized, click: actions.maximize },
    { type: 'separator' },
    { label: 'Close', accelerator: 'Alt+F4', click: actions.close }
  ]
}

function showWindowMenu(window: BrowserWindow, point?: { x: number; y: number }): void {
  const actions: WindowMenuActions = {
    restore: () => {
      if (window.isMinimized()) window.restore()
      if (window.isMaximized()) window.unmaximize()
    },
    minimize: () => window.minimize(),
    maximize: () => window.maximize(),
    close: () => window.close()
  }
  const menu = Menu.buildFromTemplate(
    windowsTitleBarMenuTemplate(
      { minimized: window.isMinimized(), maximized: window.isMaximized() },
      actions
    )
  )
  menu.popup({ window, ...point })
}

export function installWindowsTitleBarMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    if (params.y > WINDOWS_TITLE_BAR_HEIGHT || params.isEditable || params.selectionText) return
    showWindowMenu(window)
  })

  window.webContents.on('before-input-event', (event, input) => {
    const isAltSpace =
      input.type === 'keyDown' && input.alt && (input.code === 'Space' || input.key === ' ')
    if (!isAltSpace) return
    event.preventDefault()
    const bounds = window.getBounds()
    showWindowMenu(window, {
      x: bounds.x + 8,
      y: bounds.y + WINDOWS_TITLE_BAR_HEIGHT
    })
  })
}
