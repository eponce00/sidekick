import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_PANEL_MIN_WIDTH,
  ACTIVITY_PANEL_NARROW_WIDTH,
  activityPanelDragZone,
  activityPanelMaximumWidth,
  activityPanelSnapWidths,
  clampActivityPanelWidth,
  defaultActivityPanelWidth,
  snapActivityPanelWidth,
  storedActivityPanelSize,
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

  it('restores the width the user dragged it to', () => {
    expect(storedActivityPanelWidth('640', 1_440, 'wide')).toBe(640)
    expect(storedActivityPanelWidth('512', 1_400)).toBe(512)
    expect(storedActivityPanelWidth('320', 1_400)).toBe(320)
    // Someone on the narrow size of earlier versions keeps that narrow width.
    expect(storedActivityPanelWidth('720', 1_400, 'narrow')).toBe(ACTIVITY_PANEL_NARROW_WIDTH)
  })

  it('follows the viewport while no width is stored', () => {
    expect(storedActivityPanelWidth(null, 1_440)).toBeNull()
    expect(storedActivityPanelWidth('not-a-number', 1_440)).toBeNull()
    expect(defaultActivityPanelWidth(1_440)).toBe(403)
    expect(defaultActivityPanelWidth(1_000)).toBe(320)
    expect(defaultActivityPanelWidth(2_560)).toBe(440)
  })

  it('remembers the whole window, and otherwise sits beside the chat', () => {
    expect(storedActivityPanelSize('full')).toBe('full')
    expect(storedActivityPanelSize('narrow')).toBe('wide')
    expect(storedActivityPanelSize(null)).toBe('wide')
  })
})

describe('dragging the inspector edge', () => {
  it('folds when let go nearly shut, and takes the window when dragged well past the chat', () => {
    expect(activityPanelDragZone(150, 900)).toBe('fold')
    expect(activityPanelDragZone(320, 900)).toBe('side')
    expect(activityPanelDragZone(930, 900)).toBe('side')
    expect(activityPanelDragZone(960, 900)).toBe('full')
  })

  it('snaps to the narrow column and an even split with the chat', () => {
    const snaps = activityPanelSnapWidths({
      viewportWidth: 1_448,
      sidebarWidth: 48,
      sideBySideMax: 1_080
    })
    expect(snaps).toEqual([ACTIVITY_PANEL_NARROW_WIDTH, 700])
    expect(snapActivityPanelWidth(350, snaps)).toBe(320)
    expect(snapActivityPanelWidth(680, snaps)).toBe(700)
    expect(snapActivityPanelWidth(500, snaps)).toBe(500)
    // A small window leaves no room for a split distinct from the narrow column.
    expect(
      activityPanelSnapWidths({ viewportWidth: 800, sidebarWidth: 48, sideBySideMax: 432 })
    ).toEqual([ACTIVITY_PANEL_NARROW_WIDTH])
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
    expect(layout({ viewportWidth: 1_700 }).sidebarAutoCollapsed).toBe(false)
    // The sidebar, a 640 chat and a 320 panel fit in 1,240, but not in 1,200.
    expect(layout({ viewportWidth: 1_240, panelWidth: 320 }).sidebarAutoCollapsed).toBe(false)
    expect(layout({ viewportWidth: 1_200, panelWidth: 320 }).sidebarAutoCollapsed).toBe(true)
    expect(layout({ panelOpen: false }).sidebarAutoCollapsed).toBe(false)
    // With the panel on its rail, 900 leaves the chat under 640 and folds; 1,000 does not.
    expect(layout({ panelOpen: false, viewportWidth: 900 }).sidebarAutoCollapsed).toBe(true)
    expect(layout({ panelOpen: false, viewportWidth: 1_000 }).sidebarAutoCollapsed).toBe(false)
    expect(layout({ viewportWidth: 760 }).sidebarAutoCollapsed).toBe(false)
    expect(layout({ sidebarCollapsed: true }).sidebarAutoCollapsed).toBe(false)
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

  const sized = (overrides: Partial<Parameters<typeof workspaceLayout>[0]>) =>
    workspaceLayout({
      viewportWidth: 1_130,
      sidebarCollapsed: false,
      sidebarHeldOpen: false,
      panelOpen: true,
      panelWidth: 720,
      ...overrides
    })

  it('gives the full size everything but the rail, and folds the sidebar for it', () => {
    expect(sized({ panelSize: 'full' })).toEqual({
      sidebarAutoCollapsed: true,
      panelMaxWidth: 1_130 - 48
    })
    // A sidebar already folded is not folded again.
    expect(sized({ panelSize: 'full', sidebarCollapsed: true }).sidebarAutoCollapsed).toBe(false)
  })

  it('keeps the sidebar beside a narrow panel, and folds it for a wide one', () => {
    expect(
      sized({ panelSize: 'wide', panelWidth: 320, viewportWidth: 1_240 }).sidebarAutoCollapsed
    ).toBe(false)
    expect(sized({ panelSize: 'wide', panelWidth: 900 }).sidebarAutoCollapsed).toBe(true)
  })
})
