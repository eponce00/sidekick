import { Fragment, useEffect, useRef, useState } from 'react'
import { PanelRightClose, Plus, X } from 'lucide-react'
import {
  canSplit,
  chooseApp,
  closeTab,
  moveTab,
  newTab,
  resizeSections,
  selectTab,
  type PanelApp,
  type PanelDrop,
  type PanelLayout,
  type PanelTabKind
} from './panelLayout'
import './PanelSections.css'

export interface PanelAppInfo {
  label: string
  description: string
  icon: React.ReactNode
  /** A mark on the tab while it is not the one shown: the app is working, or waits for the user. */
  badge?: 'live' | 'waiting'
  /** How many things wait for the user, shown in the shared .count-badge. */
  waitingCount?: number
}

const DRAG_TYPE = 'application/x-sidekick-panel-tab'

/** Where a drag over a section's page would land: beside it, above or below, or among its tabs. */
type BodyZone = 'above' | 'below' | 'tabs'

function bodyZone(event: React.DragEvent<HTMLElement>): BodyZone {
  const rect = event.currentTarget.getBoundingClientRect()
  const at = (event.clientY - rect.top) / Math.max(1, rect.height)
  return at < 0.3 ? 'above' : at > 0.7 ? 'below' : 'tabs'
}

/**
 * The side panel's sections, stacked, each with its tabs. A tab can be dragged along its strip,
 * onto another section's strip, or onto the top or bottom of a section's page to open a section
 * there; the dividers between sections resize them. Pages drawn above the app, such as the
 * browser's, hide while a tab is dragged so the drop places show.
 */
export function PanelSections({
  layout,
  apps,
  onChange,
  renderApp,
  onFold,
  onTearOut,
  elsewhere = {},
  arriving = null
}: {
  layout: PanelLayout
  /** The apps that can open here now, with how their tabs look. */
  apps: Partial<Record<PanelApp, PanelAppInfo>>
  onChange: (layout: PanelLayout) => void
  renderApp: (kind: PanelApp, active: boolean) => React.ReactNode
  /** Folds the panel to its rail, from a button at the end of the first strip. */
  onFold?: () => void
  /** A tab let go outside the window: it opens in a window of its own. */
  onTearOut?: (app: PanelApp, screen: { x: number; y: number }) => void
  /** Apps open in windows of their own, each with how to bring its window forward. */
  elsewhere?: Partial<Record<PanelApp, () => void>>
  /** An app just put back from its own window: its tab lights up as it lands. */
  arriving?: PanelApp | null
}): React.JSX.Element {
  const [dragging, setDragging] = useState<string | null>(null)
  const [target, setTarget] = useState<PanelDrop | null>(null)
  const sectionRefs = useRef(new Map<string, HTMLElement>())

  // Pages drawn above the app read this to step aside while a tab moves.
  useEffect(() => {
    if (!dragging) return
    document.body.dataset.panelDrag = 'true'
    return () => {
      delete document.body.dataset.panelDrag
    }
  }, [dragging])

  const tabInfo = (kind: PanelTabKind): PanelAppInfo =>
    kind === 'launcher'
      ? { label: 'New tab', description: '', icon: <Plus size={14} /> }
      : (apps[kind] ?? { label: kind, description: '', icon: null })

  const drop = (event: React.DragEvent, where: PanelDrop): void => {
    const tabId = event.dataTransfer.getData(DRAG_TYPE) || dragging
    event.preventDefault()
    setTarget(null)
    setDragging(null)
    if (tabId) onChange(moveTab(layout, tabId, where))
  }

  const beginResize = (event: React.PointerEvent, index: number): void => {
    const above = layout.sections[index]
    const below = layout.sections[index + 1]
    const aboveEl = sectionRefs.current.get(above.id)
    const belowEl = sectionRefs.current.get(below.id)
    if (!aboveEl || !belowEl) return
    event.preventDefault()
    const start = event.clientY
    const aboveHeight = aboveEl.getBoundingClientRect().height
    const belowHeight = belowEl.getBoundingClientRect().height
    const total = aboveHeight + belowHeight
    const weights = above.weight + below.weight
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent): void => {
      const height = Math.min(total - 80, Math.max(80, aboveHeight + next.clientY - start))
      const share = (height / total) * weights
      onChange(resizeSections(layout, above.id, below.id, share, weights - share))
    }
    const end = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
  }

  return (
    <div className={`panel-sections${dragging ? ' is-dragging' : ''}`}>
      {layout.sections.map((section, index) => {
        const active = section.tabs.find((tab) => tab.id === section.activeTabId)
        const zone = target?.sectionId === section.id ? target : null
        return (
          <Fragment key={section.id}>
            {index > 0 && (
              <div
                className="panel-section-divider"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize the sections"
                onPointerDown={(event) => beginResize(event, index - 1)}
              />
            )}
            <section
              ref={(element) => {
                if (element) sectionRefs.current.set(section.id, element)
                else sectionRefs.current.delete(section.id)
              }}
              className={`panel-section${layout.focusedSectionId === section.id ? ' is-focused' : ''}`}
              style={{ flexGrow: section.weight }}
              onPointerDownCapture={() => {
                if (layout.focusedSectionId !== section.id)
                  onChange({ ...layout, focusedSectionId: section.id })
              }}
            >
              <div
                className={`panel-tabs${zone?.type === 'tabs' && !zone.beforeTabId ? ' is-drop-end' : ''}`}
                role="tablist"
                aria-label="Panel tabs"
                onDragOver={(event) => {
                  if (!dragging) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  if (event.target === event.currentTarget)
                    setTarget({ type: 'tabs', sectionId: section.id })
                }}
                onDrop={(event) => drop(event, target ?? { type: 'tabs', sectionId: section.id })}
              >
                {section.tabs.map((tab) => {
                  const info = tabInfo(tab.kind)
                  const selected = tab.id === section.activeTabId
                  const waitingCount = Math.max(1, info.waitingCount ?? 1)
                  return (
                    <div
                      key={tab.id}
                      className={`panel-tab${selected ? ' is-active' : ''}${
                        dragging === tab.id ? ' is-dragged' : ''
                      }${arriving === tab.kind ? ' is-arriving' : ''}${zone?.type === 'tabs' && zone.beforeTabId === tab.id ? ' is-drop-before' : ''}`}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(DRAG_TYPE, tab.id)
                        event.dataTransfer.effectAllowed = 'move'
                        setDragging(tab.id)
                      }}
                      onDragEnd={(event) => {
                        const outside =
                          event.dataTransfer.dropEffect === 'none' &&
                          (event.clientX <= 0 ||
                            event.clientY <= 0 ||
                            event.clientX >= window.innerWidth ||
                            event.clientY >= window.innerHeight)
                        setDragging(null)
                        setTarget(null)
                        if (outside && tab.kind !== 'launcher')
                          onTearOut?.(tab.kind, { x: event.screenX, y: event.screenY })
                      }}
                      onDragOver={(event) => {
                        if (!dragging) return
                        event.preventDefault()
                        event.stopPropagation()
                        const rect = event.currentTarget.getBoundingClientRect()
                        const after = event.clientX > rect.left + rect.width / 2
                        const next = section.tabs[section.tabs.indexOf(tab) + 1]
                        setTarget({
                          type: 'tabs',
                          sectionId: section.id,
                          ...(after
                            ? next
                              ? { beforeTabId: next.id }
                              : {}
                            : { beforeTabId: tab.id })
                        })
                      }}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        className="panel-tab-select"
                        title={info.description ? `${info.label}: ${info.description}` : info.label}
                        onClick={() => onChange(selectTab(layout, section.id, tab.id))}
                        onAuxClick={(event) => {
                          if (event.button === 1) onChange(closeTab(layout, tab.id))
                        }}
                      >
                        <span className="panel-tab-icon">
                          {info.icon}
                          {/* The shown app says its own state, so its tab carries no mark. */}
                          {!selected && info.badge === 'waiting' && (
                            <span
                              className="count-badge is-attention panel-tab-badge"
                              role="img"
                              aria-label={`${waitingCount} waiting for you`}
                            >
                              {waitingCount}
                            </span>
                          )}
                          {!selected && info.badge === 'live' && (
                            <span className="browser-live-dot" role="img" aria-label="Working" />
                          )}
                        </span>
                        <span className="panel-tab-label">{info.label}</span>
                      </button>
                      <button
                        type="button"
                        className="panel-tab-close"
                        aria-label={`Close ${info.label}`}
                        title="Close"
                        onClick={() => onChange(closeTab(layout, tab.id))}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )
                })}
                <button
                  type="button"
                  className="panel-tab-new"
                  aria-label="New tab"
                  title="New tab"
                  onClick={() => onChange(newTab(layout, section.id))}
                >
                  <Plus size={15} />
                </button>
                {index === 0 && onFold && <span className="panel-tabs-spacer" />}
                {index === 0 && onFold && (
                  <button
                    type="button"
                    className="panel-fold"
                    onClick={onFold}
                    title="Fold the panel to its rail"
                    aria-label="Fold the panel to its rail"
                  >
                    <PanelRightClose size={16} />
                  </button>
                )}
              </div>
              <div
                className="panel-section-body"
                onDragOver={(event) => {
                  if (!dragging) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  const where = bodyZone(event)
                  setTarget(
                    where === 'tabs' || !canSplit(layout, dragging)
                      ? { type: 'tabs', sectionId: section.id }
                      : { type: 'split', sectionId: section.id, side: where }
                  )
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                    setTarget((current) => (current?.sectionId === section.id ? null : current))
                }}
                onDrop={(event) =>
                  drop(
                    event,
                    target?.sectionId === section.id
                      ? target
                      : { type: 'tabs', sectionId: section.id }
                  )
                }
              >
                {section.tabs.map((tab) =>
                  tab.kind === 'launcher' ? (
                    tab.id === section.activeTabId && (
                      <PanelLauncher
                        key={tab.id}
                        apps={apps}
                        openApps={
                          new Set(layout.sections.flatMap((item) => item.tabs.map((t) => t.kind)))
                        }
                        elsewhere={elsewhere}
                        onChoose={(app) => {
                          const there = elsewhere[app]
                          if (there) there()
                          else onChange(chooseApp(layout, tab.id, app))
                        }}
                      />
                    )
                  ) : (
                    <Fragment key={tab.id}>{renderApp(tab.kind, tab.id === active?.id)}</Fragment>
                  )
                )}
                {dragging && zone && (
                  <div
                    className={`panel-drop-zone is-${zone.type === 'split' ? zone.side : 'tabs'}`}
                    aria-hidden="true"
                  />
                )}
              </div>
            </section>
          </Fragment>
        )
      })}
    </div>
  )
}

/** What a new tab shows: the apps the panel can hold, each opening in this tab. */
function PanelLauncher({
  apps,
  openApps,
  elsewhere,
  onChoose
}: {
  apps: Partial<Record<PanelApp, PanelAppInfo>>
  openApps: Set<PanelTabKind>
  elsewhere: Partial<Record<PanelApp, () => void>>
  onChoose: (app: PanelApp) => void
}): React.JSX.Element {
  const entries = Object.entries(apps) as Array<[PanelApp, PanelAppInfo]>
  return (
    <div className="panel-launcher">
      <div
        className="panel-launcher-grid"
        role="group"
        aria-label="Open in this tab"
        onKeyDown={moveLauncherFocus}
      >
        {entries.map(([app, info]) => {
          const where = elsewhere[app]
            ? 'In a window of its own'
            : openApps.has(app)
              ? 'Open in another tab'
              : null
          return (
            <button
              key={app}
              type="button"
              className={`panel-launcher-app${where ? ' is-open' : ''}`}
              aria-label={where ? `${info.label}, ${where.toLowerCase()}: go to it` : info.label}
              title={where ? `${info.description}\n${where}: go to it` : info.description}
              onClick={() => onChoose(app)}
            >
              <span className="panel-launcher-icon" aria-hidden="true">
                {info.icon}
              </span>
              <span className="panel-launcher-name">{info.label}</span>
              <span className="panel-launcher-open" aria-hidden="true" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Arrow keys move between the launcher's apps as they sit on screen; Home and End to the ends. */
function moveLauncherFocus(event: React.KeyboardEvent<HTMLElement>): void {
  const tiles = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button'))
  const index = tiles.indexOf(document.activeElement as HTMLElement)
  if (index < 0) return
  let next: HTMLElement | undefined
  if (event.key === 'ArrowRight') next = tiles[(index + 1) % tiles.length]
  else if (event.key === 'ArrowLeft') next = tiles[(index - 1 + tiles.length) % tiles.length]
  else if (event.key === 'Home') next = tiles[0]
  else if (event.key === 'End') next = tiles[tiles.length - 1]
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    // The tiles wrap into rows as the panel narrows, so the row above or below is found by place.
    const from = tiles[index].getBoundingClientRect()
    const down = event.key === 'ArrowDown'
    const row = tiles
      .map((tile) => ({ tile, rect: tile.getBoundingClientRect() }))
      .filter(({ rect }) => (down ? rect.top > from.bottom - 1 : rect.bottom < from.top + 1))
    const nearestTop = down
      ? Math.min(...row.map(({ rect }) => rect.top))
      : Math.max(...row.map(({ rect }) => rect.top))
    const centre = from.left + from.width / 2
    next = row
      .filter(({ rect }) => rect.top === nearestTop)
      .sort(
        (a, b) =>
          Math.abs(a.rect.left + a.rect.width / 2 - centre) -
          Math.abs(b.rect.left + b.rect.width / 2 - centre)
      )[0]?.tile
  } else return
  event.preventDefault()
  next?.focus()
}
