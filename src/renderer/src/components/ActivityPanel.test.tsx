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
          listFiles: vi.fn(async () => ({ ok: true, files: [] }))
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

  it('moves a folder to the bin after saying what it holds, but never Git’s folder', async () => {
    const api = window.api as unknown as {
      workspace: Record<string, unknown>
      permissions?: Record<string, unknown>
    }
    const trashFile = vi.fn(async () => ({ ok: true }))
    const countPathItems = vi.fn(async () => ({ count: 214, more: false }))
    Object.assign(api.workspace, {
      listFiles: vi.fn(async () => ({
        ok: true,
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
