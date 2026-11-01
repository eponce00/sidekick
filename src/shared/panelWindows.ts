/**
 * Side panel apps dragged out of the window into windows of their own. Each shows one app for one
 * chat; the main window's panel no longer holds it until it is put back.
 */
export const PANEL_WINDOW_APPS = ['browser', 'terminal', 'files'] as const
export type PanelWindowApp = (typeof PANEL_WINDOW_APPS)[number]

export interface PanelWindowEntry {
  app: PanelWindowApp
  conversationId: string
}

export function isPanelWindowApp(value: unknown): value is PanelWindowApp {
  return typeof value === 'string' && (PANEL_WINDOW_APPS as readonly string[]).includes(value)
}

/** What a panel window shows, from its address; null for the main window. */
export function panelWindowFromQuery(search: string): PanelWindowEntry | null {
  const params = new URLSearchParams(search)
  const app = params.get('panel')
  const conversationId = params.get('conversation')
  return isPanelWindowApp(app) && conversationId ? { app, conversationId } : null
}

export interface PanelWindowsAPI {
  /** Opens the app for the chat in a window of its own, near a point on the screen. */
  open: (entry: PanelWindowEntry & { x?: number; y?: number }) => Promise<boolean>
  list: () => Promise<PanelWindowEntry[]>
  /** Brings an app's window to the front. */
  focus: (entry: PanelWindowEntry) => Promise<boolean>
  /** From a panel window: closes it and puts its app back in the main window's panel. */
  dock: () => void
  onChanged: (callback: (entries: PanelWindowEntry[]) => void) => () => void
  /** In the main window: an app was put back and should show in the panel. */
  onDocked: (callback: (entry: PanelWindowEntry) => void) => () => void
}
