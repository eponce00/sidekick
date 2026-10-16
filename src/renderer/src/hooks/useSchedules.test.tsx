// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Schedule, SchedulesChangedEvent } from '../../../shared/schedules'
import { useSchedules } from './useSchedules'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const base: Schedule = {
  id: 's1',
  name: 'Nightly review',
  prompt: 'Review today.',
  projectId: null,
  modelId: 'model',
  cadence: 'daily',
  hour: 22,
  minute: 0,
  weekday: 1,
  catchUp: true,
  enabled: true,
  nextRunAt: 1,
  runCount: 1,
  createdAt: 1,
  updatedAt: 1
}

describe('useSchedules', () => {
  let container: HTMLDivElement
  let root: Root
  let listener: ((change: SchedulesChangedEvent) => void) | null
  let seen: Schedule[][]

  function Probe({ onChanged }: { onChanged: () => void }): null {
    seen.push(useSchedules(onChanged).schedules)
    return null
  }

  beforeEach(() => {
    listener = null
    seen = []
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        schedules: {
          list: vi.fn(async () => [base]),
          onChanged: (callback: (change: SchedulesChangedEvent) => void) => {
            listener = callback
            return () => (listener = null)
          }
        }
      }
    })
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    expect(listener).toBeNull()
  })

  it('follows main-process changes and refreshes chats only when a run creates or ends one', async () => {
    const onChanged = vi.fn()
    await act(async () => root.render(<Probe onChanged={onChanged} />))
    expect(seen.at(-1)).toEqual([base])

    const waiting: Schedule = {
      ...base,
      activeRun: { conversationId: 'chat', agentRunId: 'run-1', phase: 'awaiting_permission' }
    }
    await act(async () => listener!({ schedules: [waiting] }))
    expect(seen.at(-1)).toEqual([waiting])
    expect(onChanged).not.toHaveBeenCalled()

    await act(async () => listener!({ schedules: [base], conversationId: 'chat' }))
    expect(seen.at(-1)).toEqual([base])
    expect(onChanged).toHaveBeenCalledOnce()
  })
})
