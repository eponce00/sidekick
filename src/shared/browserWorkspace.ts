export interface BrowserPanelBounds {
  x: number
  y: number
  width: number
  height: number
}

import type { BrowserDeviceState } from './browserDevices'

export interface BrowserWorkspaceState {
  sessionId: string
  activeTabId: string
  userControl: boolean
  verificationHandoff?: boolean
  busy: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  /** A fixed viewport in effect on the active tab; null while it is responsive. */
  device?: BrowserDeviceState | null
  tabs: Array<{ id: string; title: string; url: string; active: boolean; loading: boolean }>
  /**
   * A picture of the page, sent with the device menu: the page is drawn above the app, so it hides
   * while SideKick's menu is open and the panel shows this in its place.
   */
  snapshot?: string
}

export interface BrowserWorkspaceRequest {
  conversationId: string
  action:
    | 'state'
    | 'mount'
    | 'unmount'
    | 'control'
    | 'resume'
    | 'url'
    | 'back'
    | 'forward'
    | 'reload'
    | 'new'
    | 'select'
    | 'close'
    | 'device'
    | 'deviceMenu'
  bounds?: BrowserPanelBounds
  /** For `deviceMenu`: where to open it, in the app window's CSS pixels. */
  menuPosition?: { x: number; y: number }
  /** For `device`: a preset id, or `responsive` for the size of the panel. */
  device?: string
  url?: string
  tabId?: string
}
