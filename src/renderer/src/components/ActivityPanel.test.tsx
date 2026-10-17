// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunChangedEvent } from '../../../shared/agentRunApi'
import type { AgentRunEvent } from '../../../shared/agentRuntime'
import ActivityPanel from './ActivityPanel'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function runEvent(
  sequence: number,
  type: AgentRunEvent['type'],
  payload: Record<string, unknown>
): AgentRunEvent {
  return {
    id: `event-${sequence}`,
    runId: 'browser-run',
    sequence,
    type,
    timestamp: sequence * 1_000,
    payload
  }
}

describe('ActivityPanel inspector', () => {
  let root: Root
  let container: HTMLDivElement
  let browserListener: ((change: AgentRunChangedEvent) => void) | null

  beforeEach(() => {
    browserListener = null
    window.localStorage.clear()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_400 })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        app: { platform: 'windows' },
        agentRuns: {
          latest: vi.fn(async () => ({ run: null, events: [], pendingInteractions: [] })),
          onEvent: vi.fn((callback: (change: AgentRunChangedEvent) => void) => {
            browserListener = callback
            return () => {
              browserListener = null
            }
          })
        },
        workspace: {
          watchFiles: vi.fn(() => () => undefined),
          listFiles: vi.fn(async () => ({ ok: true, files: [] })),
          listCheckpoints: vi.fn(async () => ({ ok: true, checkpoints: [] }))
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const renderPanel = async (isPinned = true, onTogglePin = vi.fn()): Promise<void> => {
    await act(async () =>
      root.render(
        <ActivityPanel
          isPinned={isPinned}
          onTogglePin={onTogglePin}
          conversationId="chat-1"
          focusChainTodos={[]}
          workspaceFolder={null}
        />
      )
    )
  }

  it('combines Files, Recovery, and Browser in one docked inspector', async () => {
    await renderPanel()
    const browserContent = container.querySelector('.activity-browser-wrap') as HTMLElement
    expect(browserContent.hidden).toBe(true)
    expect(container.textContent).toContain('Files')
    expect(container.textContent).toContain('Recovery')
    expect(container.textContent).toContain('Browser')
    expect(browserContent.hidden).toBe(true)

    const browserTab = container.querySelector(
      'button[aria-label="Open browser activity"]'
    ) as HTMLButtonElement
    await act(async () => browserTab.click())
    expect(browserTab.classList.contains('active')).toBe(true)
    expect(browserContent.hidden).toBe(false)
    expect(container.textContent).toContain('No browser activity yet')
  })

  it('drags its edge to any width, snapping, taking the window, and folding away', async () => {
    const onSettle = vi.fn()
    let state = { width: 500, size: 'wide' as 'wide' | 'full', pinned: true }
    const render = async (): Promise<void> => {
      await act(async () =>
        root.render(
          <ActivityPanel
            isPinned={state.pinned}
            onTogglePin={() => {
              state = { ...state, pinned: !state.pinned }
              void render()
            }}
            conversationId="chat-1"
            focusChainTodos={[]}
            workspaceFolder={null}
            maxWidth={state.size === 'full' ? 1_000 : 900}
            width={state.width}
            onWidthChange={(width) => {
              state = { ...state, width }
              void render()
            }}
            size={state.size}
            onSizeChange={(size) => {
              state = { ...state, size }
              void render()
            }}
            sideBySideMaxWidth={900}
            snapWidths={[320, 600]}
            onSettle={onSettle}
          />
        )
      )
    }
    const panel = (): HTMLElement => container.querySelector('.activity-panel') as HTMLElement
    const edge = (): HTMLElement =>
      container.querySelector('[aria-label="Resize workspace inspector"]') as HTMLElement
    const drag = async (from: number, to: number, beforeRelease?: () => void): Promise<void> => {
      await act(async () => {
        edge().dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: from })
        )
      })
      await act(async () => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: to }))
      })
      beforeRelease?.()
      await act(async () => {
        window.dispatchEvent(new MouseEvent('pointerup', { clientX: to }))
      })
    }
    await render()
    expect(panel().style.width).toBe('500px')
    // No size buttons: the edge does it all.
    expect(container.querySelector('.activity-size-button')).toBeNull()
    expect(container.querySelector('[title="Collapse panel"]')).toBeNull()

    // Let go near the even split, it glides there.
    await drag(1_000, 880)
    expect(state.width).toBe(600)
    expect(onSettle).toHaveBeenCalled()
    expect(panel().classList.contains('is-gliding')).toBe(true)

    // Well past the widest it fits beside the chat, it takes the window.
    await drag(1_000, 500, () => {
      expect(container.textContent).toContain('Full window')
    })
    expect(state.size).toBe('full')
    expect(panel().style.width).toBe('1000px')

    // From the window, dragging back sets it beside the chat at the width let go at.
    await drag(1_000, 1_300)
    expect(state.size).toBe('wide')
    expect(state.width).toBe(700)

    // Nearly shut, it folds to the rail and opens again at the width it had.
    await drag(1_000, 1_620, () => {
      expect(container.textContent).toContain('Let go to fold away')
    })
    expect(state.pinned).toBe(false)
    expect(state.width).toBe(700)
    expect(panel().classList.contains('is-collapsed')).toBe(true)

    // Dragged out from the rail, it opens.
    await drag(1_000, 400)
    expect(state.pinned).toBe(true)

    // The arrow keys move the edge too.
    state = { ...state, size: 'wide', width: 500 }
    await render()
    await act(async () => {
      edge().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(state.width).toBe(520)
  })

  it('folds to its rail when the tab already showing is clicked', async () => {
    const onTogglePin = vi.fn()
    await act(async () =>
      root.render(
        <ActivityPanel
          isPinned
          onTogglePin={onTogglePin}
          conversationId="chat-1"
          focusChainTodos={[]}
          workspaceFolder={null}
        />
      )
    )
    const filesTab = container.querySelector('.activity-tab-button.active') as HTMLButtonElement
    await act(async () => filesTab.click())
    expect(onTogglePin).toHaveBeenCalledTimes(1)
  })

  it('auto-selects Browser once when a new run starts and exposes all collapsed shortcuts', async () => {
    const toggle = vi.fn()
    await renderPanel(false, toggle)
    expect(container.querySelector('button[aria-label="Open Files"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Open Recovery"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Open Browser activity"]')).not.toBeNull()

    await act(async () => {
      browserListener?.({ event: runEvent(1, 'run.started', { threadId: 'chat-1' }) })
      browserListener?.({
        event: runEvent(2, 'tool.running', {
          name: 'browser_click',
          toolCallId: 'click-1',
          title: 'Click Continue'
        })
      })
    })
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem('activityPanelTab')).toBe('browser')
  })

  it('shows a requested tab and reports the tab it shows', async () => {
    const onActiveTabChange = vi.fn()
    const render = (tabRequest: { tab: 'browser' | 'files'; at: number } | null) =>
      act(async () =>
        root.render(
          <ActivityPanel
            isPinned
            onTogglePin={vi.fn()}
            conversationId="chat-1"
            focusChainTodos={[]}
            workspaceFolder={null}
            tabRequest={tabRequest}
            onActiveTabChange={onActiveTabChange}
          />
        )
      )
    await render(null)
    expect(onActiveTabChange).toHaveBeenLastCalledWith('files')

    await render({ tab: 'browser', at: 1 })
    const browserTab = container.querySelector(
      'button[aria-label="Open browser activity"]'
    ) as HTMLButtonElement
    expect(browserTab.classList.contains('active')).toBe(true)
    expect(onActiveTabChange).toHaveBeenLastCalledWith('browser')

    // The same request again changes nothing; the user's own choice stands.
    const filesTab = container.querySelector('.activity-tab-button') as HTMLButtonElement
    await act(async () => filesTab.click())
    await render({ tab: 'browser', at: 1 })
    expect(browserTab.classList.contains('active')).toBe(false)
  })
})
