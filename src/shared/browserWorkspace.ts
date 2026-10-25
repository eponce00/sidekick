export interface BrowserPanelBounds {
  x: number
  y: number
  width: number
  height: number
}

import type { BrowserDeviceState } from './browserDevices'
import type { BrowserPageTool } from './webMcp'

export interface BrowserWorkspaceState {
  sessionId: string
  activeTabId: string
  /** The agent waits for the user to clear a human check on the active tab's page. */
  waitingForUser?: boolean
  busy: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  /** A fixed viewport in effect on the active tab; null while it is responsive. */
  device?: BrowserDeviceState | null
  tabs: Array<{ id: string; title: string; url: string; active: boolean; loading: boolean }>
  /** The WebMCP tools the active tab's page offers the agent, with the page's origin. */
  pageTools?: { origin: string; tools: BrowserPageTool[] } | null
  /**
   * A picture of the page, sent with the device menu and for `snapshot`: the page is drawn above
   * the app, so it hides while SideKick's menu or popover is open and the panel shows this in its
   * place.
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
    /** A picture of the page, for a popover of SideKick's that opens over it. */
    | 'snapshot'
  bounds?: BrowserPanelBounds
  /** For `deviceMenu`: where to open it, in the app window's CSS pixels. */
  menuPosition?: { x: number; y: number }
  /** For `device`: a preset id, or `responsive` for the size of the panel. */
  device?: string
  url?: string
  tabId?: string
}
