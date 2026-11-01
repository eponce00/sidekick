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

/** Sent to the app window when a conversation's marks change. */
export interface BrowserAnnotationsChange {
  conversationId: string
  error?: string
  /** The user chose Send on the page: the chat sends its message with the marks. */
  send?: boolean
  /** The user turned dictation on or off for a note on the page; the app window listens. */
  dictate?: boolean
}

/** Why the active tab's page was refused for its certificate, and whether the user can go on. */
export interface BrowserCertificateNotice {
  origin: string
  reason: string
  note: string
  canContinue: boolean
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
   * A picture of the page, for `snapshot`: the page is drawn above the app, so it hides while one
   * of SideKick's menus or popovers is open and the panel shows this in its place.
   */
  snapshot?: string
  /** For `find`: which match is selected, of how many on the page. */
  found?: { active: number; matches: number }
  /** The active tab's zoom in percent; 100 unless the user zoomed it. */
  zoom?: number
  /** The user is marking places on the page to send with their next message. */
  annotating?: boolean
  annotations?: BrowserAnnotationSummary[]
  /** The active tab's page was refused for its certificate, so the panel explains in its place. */
  certificate?: BrowserCertificateNotice | null
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
    /** A picture of the page, for a popover of SideKick's that opens over it. */
    | 'snapshot'
    | 'annotate'
    | 'annotationNote'
    | 'annotationRemove'
    /** What the app window heard for the note open on the page, or that it stopped listening. */
    | 'annotationDictation'
    /** Zooms the active tab, as `zoomStep` says. */
    | 'zoom'
    | 'print'
    /** Finds `find.text` on the page; no text ends the search. */
    | 'find'
    /** Marks all of the page in view, as a picture with a note, and starts annotating. */
    | 'screenshot'
    /**
     * Asks the user, in a trusted dialog, about the certificate the main process refused on the
     * active tab. It carries nothing: what is approved is what the main process recorded.
     */
    | 'certificateContinue'
  bounds?: BrowserPanelBounds
  /** For `device`: a preset id, or `responsive` for the size of the panel. */
  device?: string
  url?: string
  tabId?: string
  /** For `annotate`: turn marking on or off, drawn in the app's accent and its text color. */
  annotate?: boolean
  accent?: string
  accentText?: string
  theme?: 'dark' | 'light'
  /** The app can take dictation, so a note on the page offers the microphone. */
  canDictate?: boolean
  dictation?: { listening: boolean; text?: string; final?: boolean }
  /** For `annotationNote` and `annotationRemove`. */
  annotationId?: string
  note?: string
  zoomStep?: import('./browserZoom').BrowserZoomStep
  /** For `find`: `next` moves to another match of the same text, backwards unless `forward`. */
  find?: { text: string; forward?: boolean; next?: boolean }
}

/** The longest text the page can be searched for. */
export const MAX_BROWSER_FIND_CHARACTERS = 500
