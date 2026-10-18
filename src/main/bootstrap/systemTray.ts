import {
  app,
  Menu,
  nativeImage,
  Notification,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage
} from 'electron'
import type { AppUpdateState } from '../../shared/appUpdates'
import { attentionDotBitmap } from '../services/attentionBadge'

/** What the tray shows; read fresh each time the menu is rebuilt. */
export interface TraySnapshot {
  /** Conversations with an agent at work. */
  workingCount: number
  /** Conversations paused on an approval or a question, oldest first. */
  waiting: { id: string; title: string }[]
  update: AppUpdateState
}

export interface TrayActions {
  open: () => void
  newChat: () => void
  openConversation: (conversationId: string) => void
  openSettings: () => void
  checkForUpdates: () => void
  installUpdate: () => void
  openRelease: () => void
  quit: () => void
}

// More than a few titles turns the menu into a second sidebar.
const MAX_WAITING_ITEMS = 3
const MAX_TITLE_LENGTH = 40

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`
}

export function workingLabel(count: number): string {
  return count === 0 ? 'No chats working' : `${plural(count, 'chat', 'chats')} working`
}

export function waitingLabel(count: number): string {
  return `${plural(count, 'chat', 'chats')} waiting for you`
}

export function trayTooltip(productName: string, snapshot: TraySnapshot): string {
  const parts: string[] = []
  if (snapshot.workingCount > 0) parts.push(workingLabel(snapshot.workingCount))
  if (snapshot.waiting.length > 0) parts.push(waitingLabel(snapshot.waiting.length))
  return parts.length ? `${productName} — ${parts.join(', ')}` : productName
}

function menuTitle(title: string): string {
  const trimmed = title.replace(/\s+/g, ' ').trim() || 'Untitled chat'
  const short =
    trimmed.length > MAX_TITLE_LENGTH ? `${trimmed.slice(0, MAX_TITLE_LENGTH - 1)}…` : trimmed
  // A lone `&` marks a mnemonic in Windows and GTK menus.
  return short.replace(/&/g, '&&')
}

/** The update entry narrates a check in progress and becomes the restart once one is ready. */
export function updateMenuItem(
  update: AppUpdateState,
  actions: Pick<TrayActions, 'checkForUpdates' | 'installUpdate' | 'openRelease'>
): MenuItemConstructorOptions {
  switch (update.status) {
    case 'checking':
      return { label: 'Checking for Updates…', enabled: false }
    case 'downloading':
      return { label: `Downloading Update… ${Math.round(update.percent)}%`, enabled: false }
    case 'installing':
      return { label: 'Installing Update…', enabled: false }
    case 'available':
      return { label: `Get SideKick ${update.update.version}…`, click: actions.openRelease }
    case 'ready':
      return {
        label: `Restart to Update to ${update.update.version}`,
        click: actions.installUpdate
      }
    default:
      return { label: 'Check for Updates…', click: actions.checkForUpdates }
  }
}

function waitingItems(
  snapshot: TraySnapshot,
  openConversation: TrayActions['openConversation']
): MenuItemConstructorOptions[] {
  if (snapshot.waiting.length === 0) return []
  const shown = snapshot.waiting.slice(0, MAX_WAITING_ITEMS)
  const more = snapshot.waiting.length - shown.length
  return [
    { label: waitingLabel(snapshot.waiting.length), enabled: false },
    ...shown.map(({ id, title }) => ({
      label: menuTitle(title),
      click: () => openConversation(id)
    })),
    ...(more > 0 ? [{ label: `${more} more in SideKick`, enabled: false }] : [])
  ]
}

export function trayMenuTemplate(
  productName: string,
  snapshot: TraySnapshot,
  actions: TrayActions
): MenuItemConstructorOptions[] {
  return [
    { label: `Open ${productName}`, click: actions.open },
    { label: 'New Chat', click: actions.newChat },
    { type: 'separator' },
    ...waitingItems(snapshot, actions.openConversation),
    { label: workingLabel(snapshot.workingCount), enabled: false },
    { type: 'separator' },
    { label: 'Settings…', click: actions.openSettings },
    updateMenuItem(snapshot.update, actions),
    { type: 'separator' },
    { label: `Quit ${productName}`, click: actions.quit }
  ]
}

/**
 * The macOS Dock menu. The Dock already opens the window and adds Quit, and the
 * update and settings entries live in the app menu, so it carries only what is new.
 */
export function dockMenuTemplate(
  snapshot: TraySnapshot,
  actions: Pick<TrayActions, 'newChat' | 'openConversation'>
): MenuItemConstructorOptions[] {
  const waiting = waitingItems(snapshot, actions.openConversation)
  return [
    { label: 'New Chat', click: actions.newChat },
    ...(waiting.length ? [{ type: 'separator' as const }, ...waiting] : [])
  ]
}

/**
 * Draws `overlay` over `base` at (left, top), both premultiplied 32-bit bitmaps
 * in the same channel order. Pixels of the overlay outside the base are dropped.
 */
export function compositeBitmap(
  base: Buffer,
  baseSize: number,
  overlay: Buffer,
  overlaySize: number,
  left: number,
  top: number
): Buffer {
  const result = Buffer.from(base)
  for (let y = 0; y < overlaySize; y += 1) {
    for (let x = 0; x < overlaySize; x += 1) {
      const targetX = left + x
      const targetY = top + y
      if (targetX < 0 || targetY < 0 || targetX >= baseSize || targetY >= baseSize) continue
      const from = (y * overlaySize + x) * 4
      const alpha = overlay[from + 3] / 255
      if (alpha === 0) continue
      const to = (targetY * baseSize + targetX) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        result[to + channel] = Math.round(
          overlay[from + channel] + result[to + channel] * (1 - alpha)
        )
      }
    }
  }
  return result
}

// Notification-area icons are 16 device-independent pixels on Windows; Linux
// indicators scale what they are given, so a larger image stays sharp there.
const ICON_SIZE: Partial<Record<NodeJS.Platform, number>> = { win32: 16 }
const LINUX_ICON_SIZE = 32
const SCALE_FACTORS = [1, 1.25, 1.5, 2, 2.5, 3] as const
// The dot fills the lower-right corner, like the taskbar's attention overlay.
const BADGE_FRACTION = 0.6

function trayImage(source: NativeImage, platform: NodeJS.Platform, badged: boolean): NativeImage {
  const size = ICON_SIZE[platform] ?? LINUX_ICON_SIZE
  const scales = platform === 'win32' ? SCALE_FACTORS : [1]
  const image = nativeImage.createEmpty()
  for (const scaleFactor of scales) {
    const pixels = Math.round(size * scaleFactor)
    const resized = source.resize({ width: pixels, height: pixels, quality: 'best' })
    let buffer = resized.toBitmap()
    if (badged) {
      const dotSize = Math.round(pixels * BADGE_FRACTION)
      buffer = compositeBitmap(
        buffer,
        pixels,
        attentionDotBitmap(dotSize),
        dotSize,
        pixels - dotSize,
        pixels - dotSize
      )
    }
    image.addRepresentation({ scaleFactor, width: pixels, height: pixels, buffer })
  }
  return image
}

export interface SystemTrayOptions {
  platform: NodeJS.Platform
  productName: string
  iconPath: string
  /** The icon's small cut, drawn at the 16-48 px a notification area uses. */
  trayIconPath: string
  snapshot: () => TraySnapshot
  actions: TrayActions
}

/** Coalesces bursts of run events (every streamed token is one) into one rebuild. */
const REFRESH_DELAY_MS = 250

/**
 * SideKick's notification-area icon on Windows and Linux. macOS keeps the Dock,
 * which already reopens the window and shows the waiting count, so there the
 * same contextual entries go into the Dock menu instead of a menu-bar extra.
 */
export class SystemTray {
  private active = false
  private tray: Tray | null = null
  private source: NativeImage | null = null
  private shownSignature = ''
  private shownBadge: boolean | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: SystemTrayOptions) {}

  get installed(): boolean {
    return this.active
  }

  /**
   * Creates the icon. False when the desktop has no tray to put it in, in which
   * case closing the window keeps its ordinary meaning.
   */
  install(): boolean {
    if (this.active) return true
    if (this.options.platform === 'darwin') {
      this.active = true
      this.render()
      return true
    }
    try {
      this.source = nativeImage.createFromPath(this.options.trayIconPath)
      this.tray = new Tray(trayImage(this.source, this.options.platform, false))
      this.shownBadge = false
      // Windows and most Linux indicators open the menu on right-click; a plain
      // click brings the window back, as in other tray apps.
      this.tray.on('click', () => this.options.actions.open())
      this.tray.on('double-click', () => this.options.actions.open())
      this.active = true
      this.render()
      return true
    } catch (error) {
      console.warn('[Tray] The desktop has no system tray to use:', error)
      this.tray?.destroy()
      this.tray = null
      return false
    }
  }

  /** Re-reads the snapshot soon; cheap enough to call on every run event. */
  refresh(): void {
    if (this.refreshTimer || !this.active) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      this.render()
    }, REFRESH_DELAY_MS)
  }

  /** Rebuilds the menu, tooltip, and icon now if anything they show changed. */
  render(): void {
    if (!this.active) return
    let snapshot: TraySnapshot
    try {
      snapshot = this.options.snapshot()
    } catch (error) {
      console.warn('[Tray] Could not read the tray state:', error)
      return
    }
    const signature = JSON.stringify(snapshot)
    if (signature === this.shownSignature) return
    this.shownSignature = signature
    const { platform, productName, actions } = this.options
    try {
      if (platform === 'darwin') {
        app.dock?.setMenu(Menu.buildFromTemplate(dockMenuTemplate(snapshot, actions)))
        return
      }
      if (!this.tray || !this.source) return
      this.tray.setContextMenu(
        Menu.buildFromTemplate(trayMenuTemplate(productName, snapshot, actions))
      )
      this.tray.setToolTip(trayTooltip(productName, snapshot))
      const badged = snapshot.waiting.length > 0
      if (badged !== this.shownBadge) {
        this.tray.setImage(trayImage(this.source, platform, badged))
        this.shownBadge = badged
      }
    } catch (error) {
      console.warn('[Tray] Could not update the tray:', error)
    }
  }

  /**
   * Tells the user, once, where the window went. Clicking the notice brings the
   * window back.
   */
  showHiddenNotice(): void {
    const { platform, productName, actions } = this.options
    const place = platform === 'win32' ? 'notification area' : 'system tray'
    const body =
      platform === 'win32'
        ? `${productName} keeps working in the ${place}. Right-click its icon there to quit.`
        : `${productName} keeps working in the ${place}. Right-click its icon there to quit, or open ${productName} again to bring the window back.`
    try {
      if (Notification.isSupported()) {
        const notice = new Notification({
          title: `${productName} is still running`,
          body,
          silent: true,
          icon: this.options.iconPath
        })
        notice.on('click', () => actions.open())
        notice.show()
      } else if (platform === 'win32') {
        this.tray?.displayBalloon({ title: `${productName} is still running`, content: body })
      }
    } catch (error) {
      console.warn('[Tray] Could not show the background notice:', error)
    }
  }

  destroy(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    if (this.active && this.options.platform === 'darwin')
      app.dock?.setMenu(Menu.buildFromTemplate([]))
    this.tray?.destroy()
    this.tray = null
    this.active = false
    this.shownSignature = ''
    this.shownBadge = null
  }
}
