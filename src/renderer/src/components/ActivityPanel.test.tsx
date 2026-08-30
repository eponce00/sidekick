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
          onFilesChanged: vi.fn(() => () => undefined),
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
    const widthControl = container.querySelector(
      'button[aria-label="Widen browser panel"]'
    ) as HTMLButtonElement
    expect(widthControl.closest('.activity-browser-wrap')).toBe(browserContent)
    expect(browserContent.hidden).toBe(true)

    const browserTab = container.querySelector(
      'button[aria-label="Open browser activity"]'
    ) as HTMLButtonElement
    await act(async () => browserTab.click())
    expect(browserTab.classList.contains('active')).toBe(true)
    expect(browserContent.hidden).toBe(false)
    expect(container.textContent).toContain('No browser activity yet')
    expect(widthControl.closest('.activity-browser-wrap')).toBe(browserContent)
  })

  it('resizes with keyboard controls, toggles a wide view, and persists width', async () => {
    await renderPanel()
    const panel = container.querySelector('.activity-panel') as HTMLElement
    const separator = container.querySelector(
      '[aria-label="Resize workspace inspector"]'
    ) as HTMLElement
    expect(panel.style.width).toBe('320px')

    await act(async () => {
      separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(panel.style.width).toBe('340px')

    const browserTab = container.querySelector(
      'button[aria-label="Open browser activity"]'
    ) as HTMLButtonElement
    await act(async () => browserTab.click())
    const widen = container.querySelector(
      'button[aria-label="Widen browser panel"]'
    ) as HTMLButtonElement
    await act(async () => widen.click())
    expect(panel.style.width).toBe('560px')
    expect(window.localStorage.getItem('activityPanelWidth')).toBe('560')
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
})
