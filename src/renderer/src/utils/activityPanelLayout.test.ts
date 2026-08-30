import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_PANEL_DEFAULT_WIDTH,
  ACTIVITY_PANEL_MAX_WIDTH,
  ACTIVITY_PANEL_MIN_WIDTH,
  activityPanelMaximumWidth,
  clampActivityPanelWidth,
  storedActivityPanelWidth
} from './activityPanelLayout'

describe('activity panel layout', () => {
  it('clamps the inspector while reserving useful chat space', () => {
    expect(clampActivityPanelWidth(100, 1_400)).toBe(ACTIVITY_PANEL_MIN_WIDTH)
    expect(clampActivityPanelWidth(900, 1_400)).toBe(ACTIVITY_PANEL_MAX_WIDTH)
    expect(activityPanelMaximumWidth(760)).toBe(712)
    expect(clampActivityPanelWidth(900, 760)).toBe(712)
  })

  it('restores only finite persisted widths', () => {
    expect(storedActivityPanelWidth(null, 1_400)).toBe(ACTIVITY_PANEL_DEFAULT_WIDTH)
    expect(storedActivityPanelWidth('512', 1_400)).toBe(512)
    expect(storedActivityPanelWidth('not-a-number', 1_400)).toBe(ACTIVITY_PANEL_DEFAULT_WIDTH)
  })
})
