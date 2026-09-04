import { describe, expect, it } from 'vitest'
import type { AgentRunEvent } from '../../../shared/agentRuntime'
import { applyBrowserActivityEvent, EMPTY_BROWSER_ACTIVITY } from './browserActivity'

function event(
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

describe('browser activity projection', () => {
  it('ignores ordinary tools and recognizes a completed browser call by its pending call id', () => {
    const ordinary = applyBrowserActivityEvent(
      EMPTY_BROWSER_ACTIVITY,
      event(1, 'tool.completed', {
        name: 'read_file',
        toolCallId: 'read-1',
        result: { status: 'success', title: 'Read file' }
      })
    )
    expect(ordinary).toBe(EMPTY_BROWSER_ACTIVITY)

    const pending = applyBrowserActivityEvent(
      ordinary,
      event(2, 'tool.pending', { name: 'browser_observe', toolCallId: 'browser-1' })
    )
    const completed = applyBrowserActivityEvent(
      pending,
      event(3, 'tool.completed', {
        toolCallId: 'browser-1',
        result: {
          status: 'success',
          title: 'Observe page',
          modelContent: 'Captured the current page.',
          data: {
            tab: { title: 'SideKick preview', url: 'http://localhost:5173/', active: true },
            screenshot: {
              path: 'C:\\internal\\viewport.png',
              url: 'sidekick-browser://artifact/run-1/viewport.png',
              mimeType: 'image/png',
              kind: 'viewport',
              width: 1440,
              height: 900
            },
            sessionId: 'session-123456',
            viewport: { width: 1440, height: 900, deviceScaleFactor: 1.25 },
            pointer: {
              x: 360,
              y: 225,
              action: 'click',
              targetMode: 'semantic',
              updatedAt: 2_800
            },
            console: [
              { level: 'warning', message: 'Deprecated API' },
              { level: 'error', message: 'Hydration failed' }
            ],
            failedRequests: [{ url: '/missing.png', errorText: '404 Not Found' }]
          },
          timing: { startedAt: 2_100, completedAt: 2_900 }
        }
      })
    )

    expect(completed).toMatchObject({
      hasActivity: true,
      screenshot: 'sidekick-browser://artifact/run-1/viewport.png',
      screenshotKind: 'viewport',
      screenshotSize: { width: 1440, height: 900 },
      pageTitle: 'SideKick preview',
      url: 'http://localhost:5173/',
      sessionId: 'session-123456',
      sessionState: 'active',
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1.25 },
      pointer: {
        x: 360,
        y: 225,
        action: 'click',
        targetMode: 'semantic',
        updatedAt: 2_800
      },
      consoleErrors: ['Hydration failed'],
      failedRequests: ['/missing.png · 404 Not Found']
    })
    expect(completed.timeline).toHaveLength(1)
    expect(completed.timeline[0]).toMatchObject({
      callId: 'browser-1',
      name: 'browser_observe',
      status: 'success',
      startedAt: 2_100,
      completedAt: 2_900
    })

    const navigated = applyBrowserActivityEvent(
      completed,
      event(4, 'tool.completed', {
        name: 'browser_navigate',
        toolCallId: 'navigate-1',
        result: {
          status: 'success',
          title: 'Opened another page',
          data: { observation: { pointer: null, tab: { url: 'https://example.com/next' } } }
        }
      })
    )
    expect(navigated.pointer).toBeUndefined()
  })

  it('normalizes screenshot attachments and file paths for direct rendering', () => {
    const attachment = applyBrowserActivityEvent(
      EMPTY_BROWSER_ACTIVITY,
      event(1, 'tool.completed', {
        name: 'browser_screenshot',
        toolCallId: 'shot-1',
        result: {
          status: 'success',
          data: { attachment: { type: 'image', mimeType: 'image/webp', data: 'YWJj' } }
        }
      })
    )
    expect(attachment.screenshot).toBe('data:image/webp;base64,YWJj')

    const artifact = applyBrowserActivityEvent(
      EMPTY_BROWSER_ACTIVITY,
      event(1, 'tool.completed', {
        name: 'browser_screenshot',
        toolCallId: 'shot-artifact',
        result: {
          status: 'success',
          data: {
            id: 'artifact-1',
            path: 'C:\\internal\\viewport.png',
            url: 'sidekick-browser://artifact/run-1/viewport.png',
            mimeType: 'image/png',
            sha256: 'abc'
          }
        }
      })
    )
    expect(artifact.screenshot).toBe('sidekick-browser://artifact/run-1/viewport.png')

    const durableMedia = applyBrowserActivityEvent(
      EMPTY_BROWSER_ACTIVITY,
      event(1, 'tool.completed', {
        name: 'browser_observe',
        toolCallId: 'shot-media',
        result: {
          status: 'success',
          data: { pageTitle: 'Media-only observation' },
          media: [
            {
              type: 'image',
              mimeType: 'image/png',
              source: { type: 'data_url', dataUrl: 'data:image/png;base64,YWJj' }
            }
          ]
        }
      })
    )
    expect(durableMedia.screenshot).toBe('data:image/png;base64,YWJj')

    const unsafePath = applyBrowserActivityEvent(
      EMPTY_BROWSER_ACTIVITY,
      event(1, 'tool.completed', {
        name: 'browser_observe',
        result: {
          status: 'success',
          data: { screenshotPath: 'C:\\Users\\test user\\preview.png' }
        }
      })
    )
    expect(unsafePath.screenshot).toBeUndefined()
  })

  it('preserves explicit partial form completion in browser activity', () => {
    const state = applyBrowserActivityEvent(
      EMPTY_BROWSER_ACTIVITY,
      event(1, 'tool.completed', {
        name: 'browser_fill_form',
        toolCallId: 'form-partial',
        result: {
          status: 'error',
          title: 'Fill browser form',
          data: { outcome: 'partial', attemptedFields: 3, filledFields: 2 }
        }
      })
    )

    expect(state.timeline[0]).toMatchObject({
      callId: 'form-partial',
      status: 'partial'
    })
  })

  it('projects visual verification progress and failure without retaining screenshots per step', () => {
    const running = applyBrowserActivityEvent(
      EMPTY_BROWSER_ACTIVITY,
      event(1, 'tool.running', {
        name: 'browser_verify',
        toolCallId: 'verify-1',
        title: 'Check responsive layout'
      })
    )
    expect(running.verification).toEqual({
      status: 'running',
      label: 'Visual verification in progress'
    })

    const failed = applyBrowserActivityEvent(
      running,
      event(2, 'tool.completed', {
        name: 'browser_verify',
        toolCallId: 'verify-1',
        result: {
          status: 'error',
          data: { verification: { status: 'failed', summary: 'Header overlaps the navigation' } }
        }
      })
    )
    expect(failed.verification).toEqual({
      status: 'failed',
      label: 'Header overlaps the navigation'
    })
    expect(failed.timeline[0]).not.toHaveProperty('screenshot')
  })

  it('does not claim a criterion passed merely because visual evidence was captured', () => {
    const captured = applyBrowserActivityEvent(
      EMPTY_BROWSER_ACTIVITY,
      event(1, 'tool.completed', {
        name: 'browser_verify',
        toolCallId: 'verify-review',
        result: {
          status: 'success',
          data: { verification: { status: 'evidence', summary: 'Check the mobile header' } }
        }
      })
    )

    expect(captured.verification).toEqual({
      status: 'review',
      label: 'Check the mobile header'
    })
  })

  it('does not promote nested field verification or retain stale visual verification', () => {
    const form = applyBrowserActivityEvent(
      EMPTY_BROWSER_ACTIVITY,
      event(1, 'tool.completed', {
        name: 'browser_fill_form',
        toolCallId: 'form-verified-fields',
        result: {
          status: 'success',
          data: { fields: [{ verification: { passed: true } }] }
        }
      })
    )
    expect(form.verification).toBeUndefined()

    const verified = applyBrowserActivityEvent(
      form,
      event(2, 'tool.completed', {
        name: 'browser_verify',
        toolCallId: 'verify-real',
        result: { status: 'success', data: { passed: true } }
      })
    )
    expect(verified.verification?.status).toBe('passed')

    const navigated = applyBrowserActivityEvent(
      verified,
      event(3, 'tool.completed', {
        name: 'browser_navigate',
        toolCallId: 'navigate-after-verification',
        result: { status: 'success', data: { observation: { humanVerification: null } } }
      })
    )
    expect(navigated.verification).toBeUndefined()

    const closed = applyBrowserActivityEvent(
      verified,
      event(4, 'tool.completed', {
        name: 'browser_close',
        toolCallId: 'close-after-verification',
        result: { status: 'success', data: { closedSessions: ['session-1'] } }
      })
    )
    expect(closed.verification).toBeUndefined()
    expect(closed.sessionState).toBe('closed')
  })

  it('projects and clears explicit human-verification blockers', () => {
    const blocked = applyBrowserActivityEvent(
      EMPTY_BROWSER_ACTIVITY,
      event(1, 'tool.completed', {
        name: 'browser_observe',
        toolCallId: 'observe-challenge',
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
    )
    expect(blocked.humanVerification).toEqual({
      kind: 'captcha_or_bot_challenge',
      message: 'Human verification is required.'
    })

    const rejectedAction = applyBrowserActivityEvent(
      blocked,
      event(2, 'tool.completed', {
        name: 'browser_click',
        toolCallId: 'rejected-challenge-click',
        result: {
          status: 'error',
          error: { message: 'Human verification required.' }
        }
      })
    )
    expect(rejectedAction.humanVerification).toEqual(blocked.humanVerification)

    const cleared = applyBrowserActivityEvent(
      blocked,
      event(3, 'tool.completed', {
        name: 'browser_observe',
        toolCallId: 'observe-cleared',
        result: { status: 'success', data: { humanVerification: null } }
      })
    )
    expect(cleared.humanVerification).toBeUndefined()

    const awaitingHuman = applyBrowserActivityEvent(
      blocked,
      event(4, 'tool.running', {
        name: 'browser_request_human',
        toolCallId: 'human-takeover'
      })
    )
    expect(awaitingHuman.humanVerification).toEqual(blocked.humanVerification)

    const continued = applyBrowserActivityEvent(
      awaitingHuman,
      event(5, 'tool.completed', {
        name: 'browser_request_human',
        toolCallId: 'human-takeover',
        result: { status: 'success', data: { completed: false } }
      })
    )
    expect(continued.humanVerification).toBeUndefined()

    const closed = applyBrowserActivityEvent(
      blocked,
      event(6, 'tool.completed', {
        name: 'browser_close',
        toolCallId: 'close-challenge',
        result: { status: 'success', data: { closedSessions: ['session-1'] } }
      })
    )
    expect(closed.humanVerification).toBeUndefined()
  })

  it('keeps the activity timeline bounded', () => {
    let state = EMPTY_BROWSER_ACTIVITY
    for (let index = 1; index <= 45; index += 1) {
      state = applyBrowserActivityEvent(
        state,
        event(index, 'tool.completed', {
          name: 'browser_click',
          toolCallId: `click-${index}`,
          result: { status: 'success', title: `Click ${index}` }
        })
      )
    }
    expect(state.timeline).toHaveLength(40)
    expect(state.timeline[0].callId).toBe('click-6')
  })
})
