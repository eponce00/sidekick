// @vitest-environment jsdom

import { act, useState } from 'react'
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
          listProjectFiles: vi.fn(async () => ({ ok: true, folders: [], files: [] }))
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
    vi.restoreAllMocks()
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

  async function resizablePanel(
    initial = { width: 400, size: 'wide' as 'wide' | 'full', pinned: true }
  ) {
    const onSizeChange = vi.fn()
    const capture = vi.fn()
    function Panel() {
      const [width, setWidth] = useState(initial.width)
      const [size, setSize] = useState(initial.size)
      const [pinned, setPinned] = useState(initial.pinned)
      return (
        <ActivityPanel
          isPinned={pinned}
          onTogglePin={() => setPinned((value) => !value)}
          focusChainTodos={[]}
          workspaceFolder={null}
          width={width}
          maxWidth={size === 'full' ? 1_352 : 1_032}
          sideBySideMaxWidth={1_032}
          snapWidths={[320, 676]}
          size={size}
          onSizeChange={(next) => {
            onSizeChange(next)
            setSize(next)
          }}
          onWidthChange={setWidth}
        />
      )
    }
    await act(async () => root.render(<Panel />))
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!
    Object.defineProperties(handle, {
      setPointerCapture: { value: capture },
      hasPointerCapture: { value: () => false }
    })
    const panel = container.querySelector<HTMLElement>('.activity-panel')!
    const pointer = async (type: string, x: number, id = 1) => {
      await act(async () => {
        const event = new MouseEvent(type, { clientX: x, button: 0, bubbles: true })
        Object.defineProperty(event, 'pointerId', { value: id })
        ;(type === 'pointerdown' ? handle : window).dispatchEvent(event)
        await new Promise((done) => window.setTimeout(done, 20))
      })
    }
    return { handle, panel, pointer, capture, onSizeChange }
  }

  it('follows intermediate widths while dragging and captures the pointer', async () => {
    const { pointer, panel, capture } = await resizablePanel()
    await pointer('pointerdown', 1_000)
    expect(capture).toHaveBeenCalledWith(1)
    await pointer('pointermove', 1_050)
    expect(panel.style.width).toBe('350px')
    await pointer('pointermove', 913)
    expect(panel.style.width).toBe('487px')
    await pointer('pointerup', 913)
    expect(panel.style.width).toBe('487px')
    expect(panel.classList.contains('is-resizing')).toBe(false)
  })

  it('stops beside the chat instead of unexpectedly expanding across the window', async () => {
    const { pointer, panel, onSizeChange } = await resizablePanel()
    await pointer('pointerdown', 1_000)
    await pointer('pointermove', 0)
    await pointer('pointerup', 0)
    expect(panel.style.width).toBe('1032px')
    expect(onSizeChange).not.toHaveBeenCalled()
    expect(panel.dataset.size).toBe('wide')
  })

  it('only snaps near release, and restores the chosen width after explicit expansion', async () => {
    const { pointer, panel } = await resizablePanel()
    await pointer('pointerdown', 1_000)
    await pointer('pointermove', 729)
    expect(panel.style.width).toBe('671px')
    await pointer('pointerup', 729)
    expect(panel.style.width).toBe('676px')
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Expand panel"]')!.click()
    )
    expect(panel.dataset.size).toBe('full')
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Restore panel beside chat"]')!
        .click()
    )
    expect(panel.dataset.size).toBe('wide')
    expect(panel.style.width).toBe('676px')
  })

  it.each(['Escape', 'pointercancel', 'blur'])(
    'restores the original width on %s',
    async (reason) => {
      const { pointer, panel } = await resizablePanel()
      await pointer('pointerdown', 1_000)
      await pointer('pointermove', 850)
      expect(panel.style.width).toBe('550px')
      await act(async () => {
        window.dispatchEvent(
          reason === 'Escape' ? new KeyboardEvent('keydown', { key: 'Escape' }) : new Event(reason)
        )
      })
      expect(panel.style.width).toBe('400px')
      expect(panel.classList.contains('is-resizing')).toBe(false)
    }
  )

  it('keeps the previous width when folding, and opens again by dragging from the rail', async () => {
    const { pointer, panel } = await resizablePanel()
    await pointer('pointerdown', 1_000)
    await pointer('pointermove', 1_300)
    await pointer('pointerup', 1_300)
    expect(panel.classList.contains('is-collapsed')).toBe(true)
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Open Files"]')!.click()
    )
    expect(panel.style.width).toBe('400px')
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Fold the panel to its rail"]')!
        .click()
    )
    await pointer('pointerdown', 1_000)
    await pointer('pointermove', 641)
    await pointer('pointerup', 641)
    expect(panel.classList.contains('is-pinned')).toBe(true)
    expect(panel.style.width).toBe('407px')
  })

  it('ignores another pointer and allows returning to the starting width', async () => {
    const { pointer, panel } = await resizablePanel()
    await pointer('pointerdown', 1_000)
    await pointer('pointermove', 800, 2)
    await pointer('pointercancel', 800, 2)
    expect(panel.style.width).toBe('400px')
    await pointer('pointermove', 900)
    await pointer('pointermove', 1_000)
    await pointer('pointerup', 1_000)
    expect(panel.style.width).toBe('400px')
  })

  it.each([
    { width: 400, size: 'full' as const, pinned: true },
    { width: 400, size: 'wide' as const, pinned: false }
  ])('restores the original layout when cancelling from $size, pinned=$pinned', async (initial) => {
    const { pointer, panel } = await resizablePanel(initial)
    await pointer('pointerdown', 1_000)
    await pointer('pointermove', initial.pinned ? 1_700 : 600)
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(panel.classList.contains('is-pinned')).toBe(initial.pinned)
    expect(panel.dataset.size).toBe(initial.pinned ? initial.size : undefined)
    if (initial.pinned) expect(panel.style.width).toBe('1352px')
  })

  it('moves a folder to the bin after saying what it holds, but never Git’s folder', async () => {
    const api = window.api as unknown as {
      workspace: Record<string, unknown>
      permissions?: Record<string, unknown>
    }
    const trashFile = vi.fn(async () => ({ ok: true }))
    const countPathItems = vi.fn(async () => ({ count: 214, more: false }))
    Object.assign(api.workspace, {
      listProjectFiles: vi.fn(async () => ({
        ok: true,
        folders: [],
        files: ['src/', 'src/app.ts', '.git/', 'README.md']
      })),
      trashFile,
      countPathItems
    })
    api.permissions = {
      authorize: vi.fn(async () => ({ approved: true, token: 'token' }))
    }
    await act(async () =>
      root.render(
        <ActivityPanel
          isPinned
          onTogglePin={vi.fn()}
          conversationId="chat-1"
          focusChainTodos={[]}
          workspaceFolder="C:/project"
        />
      )
    )
    await act(async () => new Promise((done) => setTimeout(done, 0)))

    expect(container.querySelector('button[aria-label="Delete .git"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Delete README.md"]')).not.toBeNull()
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Delete src"]')!.click()
    )
    expect(countPathItems).toHaveBeenCalledWith('C:/project', 'src')
    expect(trashFile).not.toHaveBeenCalled()
    const confirm = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'Move to Recycle Bin'
    )!
    await act(async () => confirm.click())
    expect(trashFile).toHaveBeenCalledWith(
      'C:/project',
      'src',
      expect.objectContaining({ authorizationToken: 'token' })
    )
  })

  it('auto-selects Browser once when a new run starts', async () => {
    const toggle = vi.fn()
    await renderPanel(false, toggle)
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
  })

  it('opens Browser again when the agent waits there for the user', async () => {
    const toggle = vi.fn()
    await renderPanel(false, toggle)
    await act(async () => {
      browserListener?.({ event: runEvent(1, 'run.started', { threadId: 'chat-1' }) })
      browserListener?.({
        event: runEvent(2, 'tool.running', { name: 'browser_open', toolCallId: 'open-1' })
      })
    })
    await act(async () => {
      browserListener?.({
        event: runEvent(3, 'tool.completed', {
          name: 'browser_open',
          toolCallId: 'open-1',
          result: { status: 'success' }
        })
      })
    })
    expect(toggle).toHaveBeenCalledTimes(1)
    // The user may have closed the panel since; the page they have to finish is in it.
    await act(async () => {
      browserListener?.({
        event: runEvent(4, 'tool.running', {
          name: 'browser_request_human',
          toolCallId: 'check-1',
          title: 'Waiting for you in the browser: Confirm you are human.'
        })
      })
    })
    expect(toggle).toHaveBeenCalledTimes(2)
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
    expect(onActiveTabChange).toHaveBeenLastCalledWith('browser')
  })
})
