export const ACTIVITY_PANEL_MIN_WIDTH = 280
/** The narrow size: a fixed column beside the chat. */
export const ACTIVITY_PANEL_NARROW_WIDTH = 320
/** The wide size before the user has dragged it to a width of their own. */
export const ACTIVITY_PANEL_WIDE_WIDTH = 640

/**
 * The inspector's three sizes: a narrow column, a wide one the user sizes by dragging, and the
 * whole window beside the sidebar's rail, with the chat out of the way.
 */
export type ActivityPanelSize = 'narrow' | 'wide' | 'full'
export const ACTIVITY_PANEL_SIZES: readonly ActivityPanelSize[] = ['narrow', 'wide', 'full']

/** The size after this one: narrow, wide, full, then narrow again. */
export function nextActivityPanelSize(size: ActivityPanelSize): ActivityPanelSize {
  const index = ACTIVITY_PANEL_SIZES.indexOf(size)
  return ACTIVITY_PANEL_SIZES[(index + 1) % ACTIVITY_PANEL_SIZES.length]
}

/**
 * The remembered size, or for someone who has none yet, the size their dragged width was closest
 * to before there were sizes.
 */
export function storedActivityPanelSize(
  value: string | null,
  storedWidth: string | null
): ActivityPanelSize {
  if (value === 'narrow' || value === 'wide' || value === 'full') return value
  const width = Number(storedWidth)
  return Number.isFinite(width) && width > ACTIVITY_PANEL_NARROW_WIDTH + 40 ? 'wide' : 'narrow'
}
/**
 * The narrowest the chat gets when the user widens the inspector, a phone's width. Only the
 * window limits the inspector beyond that, so a browser page can show at a desktop size.
 */
export const NARROWEST_CONVERSATION_WIDTH = 320

export function activityPanelMaximumWidth(viewportWidth: number): number {
  const reserve =
    viewportWidth <= ACTIVITY_PANEL_OVERLAY_MAX_VIEWPORT
      ? SIDEBAR_RAIL_WIDTH
      : SIDEBAR_RAIL_WIDTH + NARROWEST_CONVERSATION_WIDTH
  return Math.max(ACTIVITY_PANEL_MIN_WIDTH, viewportWidth - reserve)
}

export function clampActivityPanelWidth(width: number, viewportWidth: number): number {
  const finite = Number.isFinite(width) ? Math.round(width) : ACTIVITY_PANEL_WIDE_WIDTH
  return Math.max(
    ACTIVITY_PANEL_MIN_WIDTH,
    Math.min(activityPanelMaximumWidth(viewportWidth), finite)
  )
}

/** The wide size's width: the last one the user dragged to, never narrower than the narrow size. */
export function storedActivityPanelWidth(value: string | null, viewportWidth: number): number {
  const width = value === null ? ACTIVITY_PANEL_WIDE_WIDTH : Number(value)
  return clampActivityPanelWidth(
    Number.isFinite(width) && width > ACTIVITY_PANEL_NARROW_WIDTH
      ? width
      : ACTIVITY_PANEL_WIDE_WIDTH,
    viewportWidth
  )
}

/** How long the sidebar and the inspector take to change size. Matches --duration-layout. */
export const LAYOUT_MOTION_MS = 280

export const SIDEBAR_WIDTH = 276
export const SIDEBAR_RAIL_WIDTH = 48
/** The chat width the sidebar folds to its rail to keep beside an open inspector. */
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
 * Shares the window between the sidebar, the chat, and the inspector beside it. As the inspector
 * grows, the sidebar folds to its rail before the chat drops below a comfortable width, unless
 * the user opened it on purpose. A user who keeps widening the inspector may narrow the chat down
 * to a phone's width; the inspector stops there.
 */
export function workspaceLayout(input: {
  viewportWidth: number
  sidebarCollapsed: boolean
  sidebarHeldOpen: boolean
  panelOpen: boolean
  /** The wide size's width; the narrow size has its own. */
  panelWidth: number
  panelSize?: ActivityPanelSize
}): WorkspaceLayout {
  const unconstrained = activityPanelMaximumWidth(input.viewportWidth)
  if (!input.panelOpen || input.viewportWidth <= ACTIVITY_PANEL_OVERLAY_MAX_VIEWPORT) {
    return { sidebarAutoCollapsed: false, panelMaxWidth: unconstrained }
  }
  // Full size: everything but the sidebar's rail, and the chat steps aside.
  if (input.panelSize === 'full') {
    return {
      sidebarAutoCollapsed: !input.sidebarCollapsed,
      panelMaxWidth: Math.max(ACTIVITY_PANEL_MIN_WIDTH, input.viewportWidth - SIDEBAR_RAIL_WIDTH)
    }
  }
  const panelWidth = input.panelSize === 'narrow' ? ACTIVITY_PANEL_NARROW_WIDTH : input.panelWidth
  const room = (sidebar: number, chat: number): number => input.viewportWidth - sidebar - chat
  const sidebarAutoCollapsed =
    !input.sidebarCollapsed &&
    !input.sidebarHeldOpen &&
    Math.min(panelWidth, unconstrained) > room(SIDEBAR_WIDTH, MIN_SIDE_BY_SIDE_CONVERSATION_WIDTH)
  const sidebar =
    input.sidebarCollapsed || sidebarAutoCollapsed ? SIDEBAR_RAIL_WIDTH : SIDEBAR_WIDTH
  return {
    sidebarAutoCollapsed,
    panelMaxWidth: Math.max(
      ACTIVITY_PANEL_MIN_WIDTH,
      Math.min(unconstrained, room(sidebar, NARROWEST_CONVERSATION_WIDTH))
    )
  }
}
