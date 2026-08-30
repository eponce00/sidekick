export const ACTIVITY_PANEL_MIN_WIDTH = 280
export const ACTIVITY_PANEL_DEFAULT_WIDTH = 320
export const ACTIVITY_PANEL_WIDE_WIDTH = 560
export const ACTIVITY_PANEL_MAX_WIDTH = 720
const MIN_CONVERSATION_WIDTH = 360

export function activityPanelMaximumWidth(viewportWidth: number): number {
  const reserve = viewportWidth <= 1_050 ? 48 : MIN_CONVERSATION_WIDTH
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
