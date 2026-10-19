import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { showAppMenu } from '../services/appMenus'

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

/** `point` is in the window's CSS pixels; without one the menu opens at the pointer. */
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
  const template = windowsTitleBarMenuTemplate(
    { minimized: window.isMinimized(), maximized: window.isMaximized() },
    actions
  )
  if (!showAppMenu(window.webContents, template, point))
    Menu.buildFromTemplate(template).popup({ window })
}

export function installWindowsTitleBarMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    if (params.y > WINDOWS_TITLE_BAR_HEIGHT || params.isEditable || params.selectionText) return
    showWindowMenu(window, { x: params.x, y: params.y })
  })

  window.webContents.on('before-input-event', (event, input) => {
    const isAltSpace =
      input.type === 'keyDown' && input.alt && (input.code === 'Space' || input.key === ' ')
    if (!isAltSpace) return
    event.preventDefault()
    showWindowMenu(window, { x: 8, y: WINDOWS_TITLE_BAR_HEIGHT })
  })
}
