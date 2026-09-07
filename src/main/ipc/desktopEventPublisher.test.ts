import { describe, expect, it, vi } from 'vitest'
import type { AgentRunEvent } from '../../shared/agentRuntime'
import type { ConversationGoal } from '../../shared/conversationGoals'
import { createDesktopEventPublisher, type DesktopEventWindow } from './desktopEventPublisher'

function windowFixture() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() }
  }
}

const event = {
  id: 'private-event-id',
  payload: { secret: 'private-payload' }
} as unknown as AgentRunEvent
const goal = { id: 'private-goal-id' } as ConversationGoal

describe('desktop event publication', () => {
  it('skips destroyed windows and contents while forwarding exact typed payloads', () => {
    const closed = windowFixture()
    closed.isDestroyed.mockReturnValue(true)
    const crashed = windowFixture()
    crashed.webContents.isDestroyed.mockReturnValue(true)
    const healthy = windowFixture()
    const warn = vi.fn()
    const publish = createDesktopEventPublisher(() => [closed, crashed, healthy], warn)
    publish('agentRuns:event', { event })
    publish('conversationGoals:changed', { goal })
    expect(closed.webContents.isDestroyed).not.toHaveBeenCalled()
    expect(closed.webContents.send).not.toHaveBeenCalled()
    expect(crashed.webContents.send).not.toHaveBeenCalled()
    expect(healthy.webContents.send.mock.calls).toEqual([
      ['agentRuns:event', { event }],
      ['conversationGoals:changed', { goal }]
    ])
    expect(warn).not.toHaveBeenCalled()
  })

  it('isolates a destruction race and retries that window naturally on the next event', () => {
    const racing = windowFixture()
    racing.webContents.send.mockImplementationOnce(() => {
      throw new Error('private-error-key')
    })
    const healthy = windowFixture()
    const warn = vi.fn()
    const publish = createDesktopEventPublisher(() => [racing, healthy], warn)
    expect(() => publish('agentRuns:event', { event })).not.toThrow()
    publish('conversationGoals:changed', { goal })
    expect(racing.webContents.send).toHaveBeenCalledTimes(2)
    expect(healthy.webContents.send).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toEqual([
      '[DesktopEvents] A renderer event could not be delivered; later deliveries remain enabled.'
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-|payload|secret/)
  })

  it('bounds warnings across repeated failures and channels without disabling delivery', () => {
    const broken = windowFixture()
    broken.webContents.send.mockImplementation(() => {
      throw new Error('sensitive')
    })
    const healthy = windowFixture()
    const warn = vi.fn()
    const windows = vi.fn(() => [broken, healthy])
    const publish = createDesktopEventPublisher(windows, warn)
    for (let index = 0; index < 20; index++) {
      publish('agentRuns:event', { event })
      publish('conversationGoals:changed', { goal })
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(windows).toHaveBeenCalledTimes(40)
    expect(healthy.webContents.send).toHaveBeenCalledTimes(40)
    expect(broken.webContents.send).toHaveBeenCalledTimes(40)
  })

  it('isolates access/check races and a throwing warning sink', () => {
    const inaccessible: DesktopEventWindow = {
      isDestroyed: () => false,
      get webContents(): DesktopEventWindow['webContents'] {
        throw new Error('private-window-error')
      }
    }
    const failedCheck = windowFixture()
    failedCheck.webContents.isDestroyed.mockImplementation(() => {
      throw new Error('closed')
    })
    const healthy = windowFixture()
    const warn = vi.fn(() => {
      throw new Error('logger unavailable')
    })
    const publish = createDesktopEventPublisher(() => [inaccessible, failedCheck, healthy], warn)
    expect(() => publish('agentRuns:event', { event })).not.toThrow()
    expect(healthy.webContents.send).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('does not swallow upstream window enumeration failures', () => {
    const error = new Error('upstream failure')
    const publish = createDesktopEventPublisher(() => {
      throw error
    })
    expect(() => publish('agentRuns:event', { event })).toThrow(error)
  })
})
