export const ACTIVITY_PANEL_MIN_WIDTH = 280
/** The narrow width the edge snaps to: a column beside the chat. */
export const ACTIVITY_PANEL_NARROW_WIDTH = 320
/** The width before the user has dragged it to one of their own. */
export const ACTIVITY_PANEL_WIDE_WIDTH = 640
/** Let go narrower than this, the inspector folds to its rail of tabs. */
export const ACTIVITY_PANEL_FOLD_WIDTH = 200
/** Dragged this far past the widest it fits beside the chat, it takes the whole window. */
export const ACTIVITY_PANEL_FULL_PULL = 48
/** This close to a snap width, the dragged edge settles on it. */
export const ACTIVITY_PANEL_SNAP_DISTANCE = 48

/**
 * The inspector beside the chat at a width the user drags it to, or across the whole window
 * beside the sidebar's rail, with the chat out of the way.
 */
export type ActivityPanelSize = 'wide' | 'full'

/** The remembered size. The narrow size of earlier versions is now just a width. */
export function storedActivityPanelSize(value: string | null): ActivityPanelSize {
  return value === 'full' ? 'full' : 'wide'
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

/**
 * The last width the user left the inspector at. Someone who used the narrow size of earlier
 * versions keeps that narrow width.
 */
export function storedActivityPanelWidth(
  value: string | null,
  viewportWidth: number,
  storedSize: string | null = null
): number {
  if (storedSize === 'narrow')
    return clampActivityPanelWidth(ACTIVITY_PANEL_NARROW_WIDTH, viewportWidth)
  const width = value === null ? ACTIVITY_PANEL_WIDE_WIDTH : Number(value)
  return clampActivityPanelWidth(
    Number.isFinite(width) ? width : ACTIVITY_PANEL_WIDE_WIDTH,
    viewportWidth
  )
}

/**
 * Where a dragged edge is heading: folded to the rail, beside the chat, or across the whole
 * window. `width` is where the pointer puts the edge, before any limit; `sideBySideMax` is the
 * widest the inspector fits beside the chat.
 */
export type ActivityPanelDragZone = 'fold' | 'side' | 'full'

export function activityPanelDragZone(width: number, sideBySideMax: number): ActivityPanelDragZone {
  if (width < ACTIVITY_PANEL_FOLD_WIDTH) return 'fold'
  if (width > sideBySideMax + ACTIVITY_PANEL_FULL_PULL) return 'full'
  return 'side'
}

/**
 * The widths the edge snaps to beside the chat: the narrow column, and an even split with the
 * chat. A split too close to the narrow column, or wider than fits, is left out.
 */
export function activityPanelSnapWidths(input: {
  viewportWidth: number
  sidebarWidth: number
  sideBySideMax: number
}): number[] {
  const split = Math.round((input.viewportWidth - input.sidebarWidth) / 2)
  const widths = [ACTIVITY_PANEL_NARROW_WIDTH]
  if (
    split - ACTIVITY_PANEL_NARROW_WIDTH > ACTIVITY_PANEL_SNAP_DISTANCE * 2 &&
    split <= input.sideBySideMax
  )
    widths.push(split)
  return widths.filter((width) => width <= input.sideBySideMax)
}

/** The snap width within `distance` of `width`, or `width` itself. */
export function snapActivityPanelWidth(
  width: number,
  snapWidths: readonly number[],
  distance = ACTIVITY_PANEL_SNAP_DISTANCE
): number {
  let nearest = width
  let best = distance
  for (const snap of snapWidths) {
    const gap = Math.abs(snap - width)
    if (gap <= best) {
      nearest = snap
      best = gap
    }
  }
  return nearest
}

/** How long the sidebar and the inspector take to change size. Matches --duration-layout. */
export const LAYOUT_MOTION_MS = 280
/** How long the inspector takes to settle where its edge was let go. Matches --duration-glide. */
export const PANEL_GLIDE_MS = 420

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
  /** The width the user left it at. */
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
  const panelWidth = input.panelWidth
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
