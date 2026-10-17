import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_PANEL_DEFAULT_WIDTH,
  ACTIVITY_PANEL_MIN_WIDTH,
  activityPanelMaximumWidth,
  clampActivityPanelWidth,
  storedActivityPanelWidth,
  workspaceLayout
} from './activityPanelLayout'

describe('activity panel layout', () => {
  it('clamps the inspector while reserving useful chat space', () => {
    expect(clampActivityPanelWidth(100, 1_400)).toBe(ACTIVITY_PANEL_MIN_WIDTH)
    expect(clampActivityPanelWidth(900, 1_400)).toBe(900)
    // The rail and a phone-width chat stay; only the window limits the inspector beyond that.
    expect(clampActivityPanelWidth(5_000, 1_400)).toBe(1_400 - 48 - 320)
    expect(clampActivityPanelWidth(5_000, 2_400)).toBe(2_400 - 48 - 320)
    expect(activityPanelMaximumWidth(760)).toBe(712)
    expect(clampActivityPanelWidth(900, 760)).toBe(712)
  })

  it('restores only finite persisted widths', () => {
    expect(storedActivityPanelWidth(null, 1_400)).toBe(ACTIVITY_PANEL_DEFAULT_WIDTH)
    expect(storedActivityPanelWidth('512', 1_400)).toBe(512)
    expect(storedActivityPanelWidth('not-a-number', 1_400)).toBe(ACTIVITY_PANEL_DEFAULT_WIDTH)
  })
})

describe('workspace layout beside an open inspector', () => {
  const layout = (overrides: Partial<Parameters<typeof workspaceLayout>[0]>) =>
    workspaceLayout({
      viewportWidth: 1_130,
      sidebarCollapsed: false,
      sidebarHeldOpen: false,
      panelOpen: true,
      panelWidth: 720,
      ...overrides
    })

  it('folds the sidebar before the chat gets narrow, and narrows the panel after', () => {
    // 1,130 wide with a 276 sidebar and a 720 panel left the chat 134 pixels.
    expect(layout({})).toEqual({ sidebarAutoCollapsed: true, panelMaxWidth: 1_130 - 48 - 320 })
  })

  it('keeps a sidebar the user opened, and narrows the panel instead', () => {
    expect(layout({ sidebarHeldOpen: true })).toEqual({
      sidebarAutoCollapsed: false,
      panelMaxWidth: 1_130 - 276 - 320
    })
  })

  it('leaves everything alone when it fits, the panel is closed, or the panel floats', () => {
    expect(layout({ viewportWidth: 1_600 }).sidebarAutoCollapsed).toBe(false)
    expect(layout({ panelWidth: 320 }).sidebarAutoCollapsed).toBe(false)
    expect(layout({ panelOpen: false }).sidebarAutoCollapsed).toBe(false)
    expect(layout({ viewportWidth: 760 }).sidebarAutoCollapsed).toBe(false)
    expect(layout({ sidebarCollapsed: true }).sidebarAutoCollapsed).toBe(false)
  })
})

describe('a wide browser page', () => {
  it('fits a 1440-wide page in a 1920-wide window, narrowing the chat to a phone width', () => {
    const { panelMaxWidth } = workspaceLayout({
      viewportWidth: 1_920,
      sidebarCollapsed: false,
      sidebarHeldOpen: false,
      panelOpen: true,
      panelWidth: 1_440
    })
    expect(panelMaxWidth).toBe(1_920 - 48 - 320)
    expect(panelMaxWidth).toBeGreaterThanOrEqual(1_440)
  })
})

describe('narrow windows', () => {
  it('keeps the inspector beside the chat down to the rail, chat, and inspector minimums', () => {
    // 901 wide: the rail, the chat, and the inspector side by side, instead of a drawer over the chat.
    expect(
      workspaceLayout({
        viewportWidth: 901,
        sidebarCollapsed: false,
        sidebarHeldOpen: false,
        panelOpen: true,
        panelWidth: 649
      })
    ).toEqual({ sidebarAutoCollapsed: true, panelMaxWidth: 901 - 48 - 320 })
  })
})
