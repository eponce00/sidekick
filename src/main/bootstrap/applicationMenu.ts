import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { AppCommand } from '../../shared/appCommands'

export type ApplicationMenuActions = Record<AppCommand | 'check-for-updates', () => void>

export function applicationMenuTemplate(
  platform: NodeJS.Platform,
  applicationName: string,
  actions: ApplicationMenuActions
): MenuItemConstructorOptions[] {
  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: actions['new-chat'] },
      { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: actions['open-project'] },
      ...(platform === 'darwin'
        ? [{ type: 'separator' as const }, { role: 'close' as const }]
        : [
            { type: 'separator' as const },
            {
              label: 'Settings…',
              accelerator: 'Ctrl+,',
              click: actions['open-settings']
            },
            { type: 'separator' as const },
            { role: 'quit' as const }
          ])
    ]
  }

  const commonMenus: MenuItemConstructorOptions[] = [
    fileMenu,
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          role: 'togglefullscreen',
          accelerator: platform === 'darwin' ? 'Ctrl+Command+F' : 'F11'
        }
      ]
    },
    { role: 'windowMenu' }
  ]

  if (platform !== 'darwin') {
    return [
      ...commonMenus,
      {
        label: 'Help',
        submenu: [
          { label: 'Check for Updates…', click: actions['check-for-updates'] },
          { type: 'separator' },
          { role: 'about' }
        ]
      }
    ]
  }

  return [
    {
      label: applicationName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: actions['open-settings'] },
        { type: 'separator' },
        { label: 'Check for Updates…', click: actions['check-for-updates'] },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    ...commonMenus
  ]
}

export function installApplicationMenu(
  platform: NodeJS.Platform,
  applicationName: string,
  actions: ApplicationMenuActions
): void {
  const template = applicationMenuTemplate(platform, applicationName, actions)
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
