export const ACTIVITY_PANEL_MIN_WIDTH = 280
export const ACTIVITY_PANEL_DEFAULT_WIDTH = 320
export const ACTIVITY_PANEL_WIDE_WIDTH = 560
/** Wide enough for a browser page at a laptop's width; the window's own size limits it first. */
export const ACTIVITY_PANEL_MAX_WIDTH = 1_600
const MIN_CONVERSATION_WIDTH = 360

export function activityPanelMaximumWidth(viewportWidth: number): number {
  const reserve = viewportWidth <= ACTIVITY_PANEL_OVERLAY_MAX_VIEWPORT ? 48 : MIN_CONVERSATION_WIDTH
  const available = Math.max(ACTIVITY_PANEL_MIN_WIDTH, viewportWidth - reserve)
  return Math.min(ACTIVITY_PANEL_MAX_WIDTH, available)
}

export function clampActivityPanelWidth(width: number, viewportWidth: number): number {
  const finite = Number.isFinite(width) ? Math.round(width) : ACTIVITY_PANEL_DEFAULT_WIDTH
  return Math.max(
    ACTIVITY_PANEL_MIN_WIDTH,
    Math.min(activityPanelMaximumWidth(viewportWidth), finite)
  )
}

export function storedActivityPanelWidth(value: string | null, viewportWidth: number): number {
  return clampActivityPanelWidth(
    value === null ? ACTIVITY_PANEL_DEFAULT_WIDTH : Number(value),
    viewportWidth
  )
}

export const SIDEBAR_WIDTH = 276
export const SIDEBAR_RAIL_WIDTH = 48
/** The narrowest the chat gets beside the sidebar and an open inspector. */
export const MIN_SIDE_BY_SIDE_CONVERSATION_WIDTH = 440
/**
 * At this width and below, the inspector floats over the chat instead of sitting beside it:
 * the sidebar's rail, the narrowest chat, and the narrowest inspector no longer fit. Matches the
 * `max-width` media query in App.css.
 */
export const ACTIVITY_PANEL_OVERLAY_MAX_VIEWPORT = 767

export interface WorkspaceLayout {
  /** The sidebar folds to its rail for room, without changing the saved preference. */
  sidebarAutoCollapsed: boolean
  /** The widest the inspector may render; its preferred width is kept for when there is room. */
  panelMaxWidth: number
}

/**
 * Shares the window between the sidebar, the chat, and the inspector beside it. The chat keeps
 * its minimum: the sidebar folds to its rail first, unless the user opened it on purpose, and
 * then the inspector narrows.
 */
export function workspaceLayout(input: {
  viewportWidth: number
  sidebarCollapsed: boolean
  sidebarHeldOpen: boolean
  panelOpen: boolean
  panelWidth: number
}): WorkspaceLayout {
  const unconstrained = activityPanelMaximumWidth(input.viewportWidth)
  if (!input.panelOpen || input.viewportWidth <= ACTIVITY_PANEL_OVERLAY_MAX_VIEWPORT) {
    return { sidebarAutoCollapsed: false, panelMaxWidth: unconstrained }
  }
  const room = (sidebar: number): number =>
    input.viewportWidth - sidebar - MIN_SIDE_BY_SIDE_CONVERSATION_WIDTH
  const sidebarAutoCollapsed =
    !input.sidebarCollapsed &&
    !input.sidebarHeldOpen &&
    Math.min(input.panelWidth, unconstrained) > room(SIDEBAR_WIDTH)
  const sidebar =
    input.sidebarCollapsed || sidebarAutoCollapsed ? SIDEBAR_RAIL_WIDTH : SIDEBAR_WIDTH
  return {
    sidebarAutoCollapsed,
    panelMaxWidth: Math.max(ACTIVITY_PANEL_MIN_WIDTH, Math.min(unconstrained, room(sidebar)))
  }
}
