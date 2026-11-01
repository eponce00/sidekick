// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunChangedEvent } from '../../../shared/agentRunApi'
import type { AgentRunEvent } from '../../../shared/agentRuntime'
import BrowserActivityPanel from './BrowserActivityPanel'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function runEvent(
  sequence: number,
  type: AgentRunEvent['type'],
  payload: Record<string, unknown>
): AgentRunEvent {
  return {
    id: `event-${sequence}`,
    runId: 'run-1',
    sequence,
    type,
    timestamp: sequence * 1_000,
    payload
  }
}

describe('BrowserActivityPanel', () => {
  let container: HTMLDivElement
  let root: Root
  let listener: ((change: AgentRunChangedEvent) => void) | null

  beforeEach(() => {
    listener = null
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        agentRuns: {
          latest: vi.fn(async () => ({ run: null, events: [], pendingInteractions: [] })),
          onEvent: vi.fn((callback: (change: AgentRunChangedEvent) => void) => {
            listener = callback
            return () => {
              listener = null
            }
          })
        }
      }
    })
    window.localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('stays empty for ordinary activity and renders the selected conversation browser run', async () => {
    await act(async () => root.render(<BrowserActivityPanel conversationId="chat-1" />))

    await act(async () => {
      listener?.({ event: runEvent(1, 'run.started', { threadId: 'chat-1' }) })
      listener?.({
        event: runEvent(2, 'tool.completed', {
          name: 'read_file',
          toolCallId: 'read-1',
          result: { status: 'success' }
        })
      })
    })
    expect(container.textContent).not.toContain('Preview app')

    await act(async () => {
      listener?.({
        event: runEvent(3, 'tool.completed', {
          name: 'browser_observe',
          toolCallId: 'browser-1',
          result: {
            status: 'success',
            title: 'Observed preview',
            data: {
              screenshot: 'data:image/png;base64,YWJj',
              pageTitle: 'Preview app',
              pageUrl: 'http://localhost:5173',
              viewport: { width: 1280, height: 720 }
            }
          }
        })
      })
    })

    expect(container.textContent).toContain('Preview app')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,YWJj')
  })

  it('rehydrates browser activity from the latest durable run', async () => {
    vi.mocked(window.api.agentRuns.latest).mockResolvedValue({
      run: {
        id: 'run-1',
        threadId: 'chat-1',
        surface: 'conversation',
        executionMode: 'act',
        phase: 'completed',
        provider: 'litellm',
        model: 'qwen',
        lastSequence: 2,
        startedAt: 1_000,
        updatedAt: 2_000,
        completedAt: 2_000
      },
      events: [
        runEvent(1, 'run.started', { threadId: 'chat-1' }),
        runEvent(2, 'tool.completed', {
          name: 'browser_verify',
          toolCallId: 'verify-1',
          result: {
            status: 'success',
            title: 'Verify responsive layout',
            data: {
              passed: true,
              observation: {
                sessionId: 'session-1',
                tab: { title: 'Finished preview', url: 'http://localhost:5173' },
                viewport: { width: 390, height: 844 }
              }
            }
          }
        })
      ],
      pendingInteractions: []
    })

    await act(async () => root.render(<BrowserActivityPanel conversationId="chat-1" />))
    await act(async () => Promise.resolve())

    expect(container.textContent).toContain('Finished preview')
  })

  it('reports live activity and overlays the last resolved interaction point', async () => {
    const onActivityChange = vi.fn()
    await act(async () =>
      root.render(
        <BrowserActivityPanel conversationId="chat-1" onActivityChange={onActivityChange} />
      )
    )
    await act(async () => {
      listener?.({ event: runEvent(1, 'run.started', { threadId: 'chat-1' }) })
      listener?.({
        event: runEvent(2, 'tool.running', {
          name: 'browser_click',
          toolCallId: 'browser-1',
          title: 'Click Sign in'
        })
      })
    })
    expect(onActivityChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ runId: 'run-1', hasActivity: true })
    )

    await act(async () => {
      listener?.({
        event: runEvent(3, 'tool.completed', {
          name: 'browser_click',
          toolCallId: 'browser-1',
          result: {
            status: 'success',
            title: 'Clicked Sign in',
            data: {
              action: 'click',
              observation: {
                viewport: { width: 1_000, height: 500 },
                pointer: {
                  x: 250,
                  y: 100,
                  action: 'click',
                  targetMode: 'semantic',
                  updatedAt: 3_000
                },
                screenshot: {
                  url: 'data:image/png;base64,YWJj',
                  mimeType: 'image/png',
                  kind: 'viewport',
                  width: 1_000,
                  height: 500
                }
              }
            }
          }
        })
      })
    })
    const pointer = container.querySelector(
      '[aria-label="Last browser interaction: click"]'
    ) as HTMLElement
    expect(pointer).not.toBeNull()
    expect(pointer.style.left).toBe('25%')
    expect(pointer.style.top).toBe('20%')
  })

  it('shows a human-action blocker instead of stale verified status', async () => {
    await act(async () => root.render(<BrowserActivityPanel conversationId="chat-1" />))
    await act(async () => {
      listener?.({ event: runEvent(1, 'run.started', { threadId: 'chat-1' }) })
      listener?.({
        event: runEvent(2, 'tool.completed', {
          name: 'browser_verify',
          toolCallId: 'verify-before-challenge',
          result: { status: 'success', data: { passed: true } }
        })
      })
      listener?.({
        event: runEvent(3, 'tool.completed', {
          name: 'browser_observe',
          toolCallId: 'challenge',
          result: {
            status: 'success',
            data: {
              humanVerification: {
                required: true,
                kind: 'captcha_or_bot_challenge',
                message: 'Human verification is required.'
              }
            }
          }
        })
      })
      listener?.({
        event: runEvent(4, 'tool.running', {
          name: 'browser_request_human',
          toolCallId: 'takeover-pending'
        })
      })
    })

    expect(container.textContent).not.toContain('Visual check passed')
    expect(container.querySelector('.browser-activity-panel')?.getAttribute('data-status')).toBe(
      'blocked'
    )
  })
})
