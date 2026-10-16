// @vitest-environment jsdom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionStatus, SessionsChangedEvent } from '../../../shared/sessions'
import { useSessionStatuses, type SessionStatuses } from './useSessionStatuses'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let listener: ((change: SessionsChangedEvent) => void) | null = null
let resolveInitial: (statuses: SessionStatus[]) => void = () => undefined
const probe: { latest: SessionStatuses | null } = { latest: null }
let root: Root | null = null
let container: HTMLDivElement | null = null

function Probe({ onAlert }: { onAlert: (alert: unknown) => void }): null {
  const statuses = useSessionStatuses(onAlert)
  useEffect(() => {
    probe.latest = statuses
  }, [statuses])
  return null
}

function status(conversationId: string, state: SessionStatus['state']): SessionStatus {
  return { conversationId, state, since: 1 }
}

function change(statuses: SessionStatus[], extra: Partial<SessionsChangedEvent> = {}) {
  act(() =>
    listener?.({
      kind: 'status',
      conversationIds: statuses.map(({ conversationId }) => conversationId),
      statuses,
      ...extra
    })
  )
}

beforeEach(() => {
  listener = null
  probe.latest = null
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      sessions: {
        statuses: vi.fn(
          () =>
            new Promise<SessionStatus[]>((resolve) => {
              resolveInitial = resolve
            })
        ),
        onChanged: vi.fn((callback: (change: SessionsChangedEvent) => void) => {
          listener = callback
          return () => {
            listener = null
          }
        })
      }
    }
  })
  container = document.createElement('div')
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container = null
})

describe('useSessionStatuses', () => {
  it('shows a chat the main process is running, though no panel here started it', async () => {
    act(() => root!.render(<Probe onAlert={vi.fn()} />))
    await act(async () => resolveInitial([status('scheduled', 'working')]))

    expect([...probe.latest!.active]).toEqual(['scheduled'])
    expect(probe.latest!.waiting.size).toBe(0)
  })

  it('follows changes, drops chats that went idle, and passes alerts on', async () => {
    const onAlert = vi.fn()
    act(() => root!.render(<Probe onAlert={onAlert} />))
    await act(async () => resolveInitial([status('a', 'working'), status('b', 'done')]))

    change([status('a', 'waiting')], { alerts: [{ conversationId: 'a', reason: 'approval' }] })
    expect([...probe.latest!.waiting]).toEqual(['a'])
    expect([...probe.latest!.active]).toEqual(['a'])
    expect(onAlert).toHaveBeenCalledWith({ conversationId: 'a', reason: 'approval' })

    change([status('a', 'idle'), status('b', 'idle')])
    expect(probe.latest!.byId.size).toBe(0)
  })

  it('keeps a change that arrives before the first read', async () => {
    act(() => root!.render(<Probe onAlert={vi.fn()} />))
    change([status('a', 'working')])
    await act(async () => resolveInitial([]))
    expect([...probe.latest!.active]).toEqual(['a'])
  })

  it('keeps a manager whose own state is idle while its family is busy', async () => {
    act(() => root!.render(<Probe onAlert={vi.fn()} />))
    await act(async () => resolveInitial([]))
    change([
      {
        ...status('manager', 'idle'),
        family: {
          state: 'waiting',
          counts: { queued: 0, working: 0, waiting: 1, done: 0, idle: 0, failed: 0, stopped: 0 }
        }
      }
    ])
    expect(probe.latest!.byId.get('manager')?.family?.state).toBe('waiting')
    expect(probe.latest!.active.size).toBe(0)
  })
})
