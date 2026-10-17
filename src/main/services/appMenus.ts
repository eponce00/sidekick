import { randomUUID } from 'crypto'
import {
  BrowserWindow,
  screen,
  type MenuItemConstructorOptions,
  type NativeImage,
  type WebContents
} from 'electron'
import type { AppMenuItem, AppMenuRequest } from '../../shared/appMenus'

/** Edit roles the window can perform itself; any other role keeps the native menu. */
const EDIT_ROLES: Record<
  string,
  { label: string; shortcut: string; run: (contents: WebContents) => void }
> = {
  undo: { label: 'Undo', shortcut: 'Ctrl+Z', run: (contents) => contents.undo() },
  redo: { label: 'Redo', shortcut: 'Ctrl+Y', run: (contents) => contents.redo() },
  cut: { label: 'Cut', shortcut: 'Ctrl+X', run: (contents) => contents.cut() },
  copy: { label: 'Copy', shortcut: 'Ctrl+C', run: (contents) => contents.copy() },
  paste: { label: 'Paste', shortcut: 'Ctrl+V', run: (contents) => contents.paste() },
  pasteAndMatchStyle: {
    label: 'Paste and Match Style',
    shortcut: 'Ctrl+Shift+V',
    run: (contents) => contents.pasteAndMatchStyle()
  },
  delete: { label: 'Delete', shortcut: '', run: (contents) => contents.delete() },
  selectAll: { label: 'Select All', shortcut: 'Ctrl+A', run: (contents) => contents.selectAll() }
}

interface MenuSession {
  webContentsId: number
  actions: Map<string, () => void>
  onClose?: () => void
}

/** Open menus by token. A token ends when an item is chosen or the menu closes. */
const sessions = new Map<string, MenuSession>()

function shortcutLabel(accelerator: MenuItemConstructorOptions['accelerator']): string | undefined {
  if (typeof accelerator !== 'string' || !accelerator) return undefined
  const mac = process.platform === 'darwin'
  return accelerator
    .replace(/CommandOrControl|CmdOrCtrl/g, mac ? '⌘' : 'Ctrl')
    .replace(/Command|Cmd/g, '⌘')
    .replace(/Control/g, 'Ctrl')
}

function iconData(icon: MenuItemConstructorOptions['icon']): string | undefined {
  if (!icon || typeof icon === 'string') return undefined
  const image = icon as NativeImage
  return image.isEmpty() ? undefined : image.toDataURL()
}

/**
 * Turns an Electron menu template into one the window draws, keeping each click here. Returns
 * null when an item needs the native menu, such as a role only the system can perform.
 */
export function appMenuItems(
  template: MenuItemConstructorOptions[],
  contents: WebContents,
  actions: Map<string, () => void>
): AppMenuItem[] | null {
  const items: AppMenuItem[] = []
  for (const entry of template) {
    if (entry.visible === false) continue
    const id = randomUUID()
    if (entry.type === 'separator') {
      items.push({ id, type: 'separator' })
      continue
    }
    if (entry.role) {
      const role = EDIT_ROLES[entry.role]
      if (!role) return null
      actions.set(id, () => role.run(contents))
      items.push({
        id,
        type: 'normal',
        label: entry.label ?? role.label,
        shortcut: role.shortcut || undefined,
        enabled: entry.enabled !== false
      })
      continue
    }
    if (entry.submenu) {
      if (!Array.isArray(entry.submenu)) return null
      const submenu = appMenuItems(entry.submenu, contents, actions)
      if (!submenu) return null
      items.push({ id, type: 'submenu', label: entry.label, icon: iconData(entry.icon), submenu })
      continue
    }
    // A disabled item with no action in a list of choices is a group heading.
    if (entry.enabled === false && !entry.click && entry.type !== 'checkbox') {
      items.push({ id, type: 'heading', label: entry.label })
      continue
    }
    const click = entry.click
    if (click) actions.set(id, () => click({} as never, undefined, {} as never))
    items.push({
      id,
      type: entry.type === 'checkbox' || entry.type === 'radio' ? 'checkbox' : 'normal',
      label: entry.label,
      icon: iconData(entry.icon),
      shortcut: shortcutLabel(entry.accelerator),
      checked: entry.checked,
      enabled: entry.enabled !== false && Boolean(click)
    })
  }
  return items
}

/** Where the pointer is, in the window's CSS pixels, for menus opened from a click. */
export function pointerPosition(contents: WebContents): { x: number; y: number } {
  const window = BrowserWindow.fromWebContents(contents)
  const point = screen.getCursorScreenPoint()
  const bounds = window?.getContentBounds() ?? { x: 0, y: 0 }
  const zoom = contents.getZoomFactor() || 1
  return { x: (point.x - bounds.x) / zoom, y: (point.y - bounds.y) / zoom }
}

/**
 * Shows a menu drawn by the window in SideKick's style. Returns false when the template needs the
 * native menu, so the caller can fall back to it.
 */
export function showAppMenu(
  contents: WebContents,
  template: MenuItemConstructorOptions[],
  position: { x: number; y: number } = pointerPosition(contents),
  onClose?: () => void
): boolean {
  if (contents.isDestroyed()) return false
  const actions = new Map<string, () => void>()
  const items = appMenuItems(template, contents, actions)
  if (!items || !items.length) return false
  // Only one menu is open per window; opening another closes the last.
  for (const [token, session] of sessions)
    if (session.webContentsId === contents.id) closeSession(token)
  const token = randomUUID()
  sessions.set(token, { webContentsId: contents.id, actions, onClose })
  const request: AppMenuRequest = { token, items, x: position.x, y: position.y }
  contents.send('menus:show', request)
  return true
}

function closeSession(token: string): MenuSession | undefined {
  const session = sessions.get(token)
  if (!session) return undefined
  sessions.delete(token)
  session.onClose?.()
  return session
}

/** The window chose an item: perform it, if the menu was opened for that window. */
export function chooseAppMenuItem(contents: WebContents, token: string, itemId: string): void {
  const session = sessions.get(token)
  if (!session || session.webContentsId !== contents.id) return
  const action = session.actions.get(itemId)
  closeSession(token)
  action?.()
}

export function dismissAppMenu(contents: WebContents, token: string): void {
  const session = sessions.get(token)
  if (!session || session.webContentsId !== contents.id) return
  closeSession(token)
}
