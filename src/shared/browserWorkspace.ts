export interface BrowserPanelBounds {
  x: number
  y: number
  width: number
  height: number
}

import type { BrowserDeviceState } from './browserDevices'
import type { BrowserPageTool } from './webMcp'

/** How many places one message can point at on pages; they share the message's attachments. */
export const MAX_BROWSER_ANNOTATIONS = 8

/** A mark as the Browser panel lists it; its picture and page facts stay in the main process. */
export interface BrowserAnnotationSummary {
  id: string
  number: number
  name: string
  note: string
  target: 'element' | 'area'
  /** It was made on the page the active tab shows now, so it is drawn there while annotating. */
  onPage: boolean
}

/** Sent to the app window when a conversation's marks change; `focus` is a mark just made. */
export interface BrowserAnnotationsChange {
  conversationId: string
  focus?: string
  error?: string
}

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
   * A picture of the page, sent with the device menu: the page is drawn above the app, so it hides
   * while SideKick's menu is open and the panel shows this in its place.
   */
  snapshot?: string
  /** The user is marking places on the page to send with their next message. */
  annotating?: boolean
  annotations?: BrowserAnnotationSummary[]
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
    | 'annotate'
    | 'annotationNote'
    | 'annotationRemove'
  bounds?: BrowserPanelBounds
  /** For `deviceMenu`: where to open it, in the app window's CSS pixels. */
  menuPosition?: { x: number; y: number }
  /** For `device`: a preset id, or `responsive` for the size of the panel. */
  device?: string
  url?: string
  tabId?: string
  /** For `annotate`: turn marking on or off, drawn in the app's accent and its text color. */
  annotate?: boolean
  accent?: string
  accentText?: string
  /** For `annotationNote` and `annotationRemove`. */
  annotationId?: string
  note?: string
}
