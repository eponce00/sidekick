export interface BrowserPanelBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserWorkspaceState {
  sessionId: string
  activeTabId: string
  userControl: boolean
  verificationHandoff?: boolean
  busy: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  tabs: Array<{ id: string; title: string; url: string; active: boolean; loading: boolean }>
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
  bounds?: BrowserPanelBounds
  url?: string
  tabId?: string
}
