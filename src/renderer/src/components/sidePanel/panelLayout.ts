/**
 * The side panel's layout: stacked sections, each with its own tabs. A tab shows one app, or the
 * launcher a new tab opens on. Each app is open at most once, so choosing one that is open goes to
 * its tab. Every change returns a new layout and leaves no empty section behind.
 */
export type PanelApp = 'files' | 'browser' | 'terminal' | 'chats'
export type PanelTabKind = PanelApp | 'launcher'

export interface PanelTab {
  id: string
  kind: PanelTabKind
}

export interface PanelSection {
  id: string
  tabs: PanelTab[]
  activeTabId: string
  /** Its share of the panel's height, against the other sections' shares. */
  weight: number
}

export interface PanelLayout {
  sections: PanelSection[]
  /** The section the user last used; a new tab or an app opened from elsewhere goes there. */
  focusedSectionId: string
}

export const PANEL_APPS: readonly PanelApp[] = ['files', 'browser', 'terminal', 'chats']
const MAX_SECTIONS = 4
const STORAGE_KEY = 'sidePanelLayout'

let counter = 0
const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(counter += 1).toString(36)}`

function section(tabs: PanelTab[], weight = 1): PanelSection {
  return { id: newId('section'), tabs, activeTabId: tabs[0].id, weight }
}

export function defaultPanelLayout(app: PanelApp = 'files'): PanelLayout {
  const first = section([{ id: newId('tab'), kind: app }])
  return { sections: [first], focusedSectionId: first.id }
}

/** Drops empty sections, keeps an active tab and a focused section that exist. */
function normalize(layout: PanelLayout): PanelLayout {
  const sections = layout.sections
    .filter((item) => item.tabs.length > 0)
    .map((item) =>
      item.tabs.some((tab) => tab.id === item.activeTabId)
        ? item
        : { ...item, activeTabId: item.tabs[item.tabs.length - 1].id }
    )
  if (!sections.length) return defaultPanelLayout()
  const focusedSectionId = sections.some((item) => item.id === layout.focusedSectionId)
    ? layout.focusedSectionId
    : sections[0].id
  return { sections, focusedSectionId }
}

export function findApp(
  layout: PanelLayout,
  app: PanelTabKind
): { section: PanelSection; tab: PanelTab } | undefined {
  for (const item of layout.sections) {
    const tab = item.tabs.find((candidate) => candidate.kind === app)
    if (tab) return { section: item, tab }
  }
  return undefined
}

/** The apps on screen now: each section's active tab. */
export function shownApps(layout: PanelLayout): PanelTabKind[] {
  return layout.sections.map(
    (item) => item.tabs.find((tab) => tab.id === item.activeTabId)?.kind ?? 'launcher'
  )
}

export function selectTab(layout: PanelLayout, sectionId: string, tabId: string): PanelLayout {
  return {
    sections: layout.sections.map((item) =>
      item.id === sectionId && item.tabs.some((tab) => tab.id === tabId)
        ? { ...item, activeTabId: tabId }
        : item
    ),
    focusedSectionId: sectionId
  }
}

/**
 * Shows an app: its tab if it is open, else in the focused section, taking the place of a launcher
 * showing there, or as a new tab.
 */
export function openApp(layout: PanelLayout, app: PanelApp): PanelLayout {
  const open = findApp(layout, app)
  if (open) return selectTab(layout, open.section.id, open.tab.id)
  const target =
    layout.sections.find((item) => item.id === layout.focusedSectionId) ?? layout.sections[0]
  const shown = target.tabs.find((tab) => tab.id === target.activeTabId)
  const tab: PanelTab =
    shown?.kind === 'launcher' ? { id: shown.id, kind: app } : { id: newId('tab'), kind: app }
  return {
    sections: layout.sections.map((item) =>
      item.id !== target.id
        ? item
        : {
            ...item,
            tabs:
              shown?.kind === 'launcher'
                ? item.tabs.map((candidate) => (candidate.id === shown.id ? tab : candidate))
                : [...item.tabs, tab],
            activeTabId: tab.id
          }
    ),
    focusedSectionId: target.id
  }
}

/** Turns a launcher tab into the app chosen on it; an app open elsewhere is shown there instead. */
export function chooseApp(layout: PanelLayout, tabId: string, app: PanelApp): PanelLayout {
  const open = findApp(layout, app)
  if (open) {
    const shown = selectTab(layout, open.section.id, open.tab.id)
    return normalize({
      ...shown,
      sections: shown.sections.map((item) => ({
        ...item,
        tabs: item.tabs.filter((tab) => tab.id !== tabId)
      }))
    })
  }
  const host = layout.sections.find((item) => item.tabs.some((tab) => tab.id === tabId))
  if (!host) return openApp(layout, app)
  return {
    sections: layout.sections.map((item) =>
      item.id !== host.id
        ? item
        : {
            ...item,
            tabs: item.tabs.map((tab) => (tab.id === tabId ? { id: tab.id, kind: app } : tab)),
            activeTabId: tabId
          }
    ),
    focusedSectionId: host.id
  }
}

/** A new tab on the launcher, in a section; an open launcher there is shown instead. */
export function newTab(layout: PanelLayout, sectionId: string): PanelLayout {
  const host = layout.sections.find((item) => item.id === sectionId) ?? layout.sections[0]
  const launcher = host.tabs.find((tab) => tab.kind === 'launcher')
  if (launcher) return selectTab(layout, host.id, launcher.id)
  const tab: PanelTab = { id: newId('tab'), kind: 'launcher' }
  return {
    sections: layout.sections.map((item) =>
      item.id === host.id ? { ...item, tabs: [...item.tabs, tab], activeTabId: tab.id } : item
    ),
    focusedSectionId: host.id
  }
}

/** Closes a tab; its neighbour shows. The panel's last tab becomes the launcher, never nothing. */
export function closeTab(layout: PanelLayout, tabId: string): PanelLayout {
  const host = layout.sections.find((item) => item.tabs.some((tab) => tab.id === tabId))
  if (!host) return layout
  if (layout.sections.length === 1 && host.tabs.length === 1) {
    const launcher: PanelTab = { id: newId('tab'), kind: 'launcher' }
    return {
      sections: [{ ...host, tabs: [launcher], activeTabId: launcher.id }],
      focusedSectionId: host.id
    }
  }
  const index = host.tabs.findIndex((tab) => tab.id === tabId)
  const tabs = host.tabs.filter((tab) => tab.id !== tabId)
  const activeTabId =
    host.activeTabId === tabId ? (tabs[Math.max(0, index - 1)]?.id ?? '') : host.activeTabId
  return normalize({
    ...layout,
    sections: layout.sections.map((item) =>
      item.id === host.id ? { ...item, tabs, activeTabId } : item
    )
  })
}

/** Where a dragged tab lands: in a section's tabs before another tab (or at the end), or as a new section beside one. */
export type PanelDrop =
  | { type: 'tabs'; sectionId: string; beforeTabId?: string }
  | { type: 'split'; sectionId: string; side: 'above' | 'below' }

export function canSplit(layout: PanelLayout, tabId: string): boolean {
  const host = layout.sections.find((item) => item.tabs.some((tab) => tab.id === tabId))
  // A section's only tab moving beside itself would leave the layout as it was.
  return layout.sections.length < MAX_SECTIONS || Boolean(host && host.tabs.length === 1)
}

export function moveTab(layout: PanelLayout, tabId: string, drop: PanelDrop): PanelLayout {
  const host = layout.sections.find((item) => item.tabs.some((tab) => tab.id === tabId))
  const tab = host?.tabs.find((candidate) => candidate.id === tabId)
  if (!host || !tab) return layout
  const without = layout.sections.map((item) =>
    item.id === host.id
      ? { ...item, tabs: item.tabs.filter((candidate) => candidate.id !== tabId) }
      : item
  )
  if (drop.type === 'tabs') {
    return normalize({
      sections: without.map((item) => {
        if (item.id !== drop.sectionId) return item
        const at = drop.beforeTabId
          ? item.tabs.findIndex((candidate) => candidate.id === drop.beforeTabId)
          : -1
        const tabs = [...item.tabs]
        tabs.splice(at < 0 ? tabs.length : at, 0, tab)
        return { ...item, tabs, activeTabId: tab.id }
      }),
      focusedSectionId: drop.sectionId
    })
  }
  if (!canSplit(layout, tabId)) return layout
  const added = section([tab])
  const sections: PanelSection[] = []
  for (const item of without) {
    if (item.id === drop.sectionId && drop.side === 'above') sections.push(added)
    sections.push(item)
    if (item.id === drop.sectionId && drop.side === 'below') sections.push(added)
  }
  if (!sections.includes(added)) sections.push(added)
  // The new section takes half of the one it splits.
  const half = (sections.find((item) => item.id === drop.sectionId)?.weight ?? 1) / 2
  return normalize({
    sections: sections.map((item) =>
      item.id === drop.sectionId || item === added ? { ...item, weight: half } : item
    ),
    focusedSectionId: added.id
  })
}

/** Sets two neighbouring sections' shares as their divider is dragged. */
export function resizeSections(
  layout: PanelLayout,
  aboveId: string,
  belowId: string,
  aboveWeight: number,
  belowWeight: number
): PanelLayout {
  return {
    ...layout,
    sections: layout.sections.map((item) =>
      item.id === aboveId
        ? { ...item, weight: aboveWeight }
        : item.id === belowId
          ? { ...item, weight: belowWeight }
          : item
    )
  }
}

/** Takes an app out of the panel, as when it moves to its own window. */
export function removeApp(layout: PanelLayout, app: PanelApp): PanelLayout {
  const open = findApp(layout, app)
  return open ? closeTab(layout, open.tab.id) : layout
}

const kinds = new Set<string>([...PANEL_APPS, 'launcher'])

/** The layout as last left, or the default; a stored one that does not parse is ignored. */
export function storedPanelLayout(fallbackApp: PanelApp = 'files'): PanelLayout {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as PanelLayout | null
    if (!raw || !Array.isArray(raw.sections)) return defaultPanelLayout(fallbackApp)
    const seen = new Set<string>()
    const sections = raw.sections.slice(0, MAX_SECTIONS).map((item) => ({
      id: String(item.id),
      activeTabId: String(item.activeTabId),
      weight: Number.isFinite(item.weight) && item.weight > 0 ? item.weight : 1,
      tabs: (Array.isArray(item.tabs) ? item.tabs : []).filter((tab) => {
        // Each app once; launchers can be several.
        if (!tab || !kinds.has(tab.kind)) return false
        if (tab.kind !== 'launcher' && seen.has(tab.kind)) return false
        seen.add(tab.kind)
        return true
      })
    }))
    return normalize({ sections, focusedSectionId: String(raw.focusedSectionId) })
  } catch {
    return defaultPanelLayout(fallbackApp)
  }
}

export function storePanelLayout(layout: PanelLayout): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // A full or blocked storage only loses the layout for next time.
  }
}
