// @vitest-environment jsdom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionsChangedEvent } from '../../../shared/sessions'
import { familyMember } from '../components/sessionTestFixtures'
import { familyProjectTag, useSessionFamily, type SessionFamilyView } from './useSessionFamily'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const manager = familyMember(null, { state: 'working' })
const worker = familyMember('schedules', { state: 'working' })

describe('useSessionFamily', () => {
  let container: HTMLDivElement
  let root: Root
  let emit: (change: SessionsChangedEvent) => void
  let family: ReturnType<typeof vi.fn>
  let latest: SessionFamilyView | null

  function Probe({ id }: { id: string }): null {
    const view = useSessionFamily(id)
    useEffect(() => {
      latest = view
    })
    return null
  }

  beforeEach(() => {
    latest = null
    family = vi.fn(async () => ({ rootConversationId: 'manager', manager, workers: [worker] }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        sessions: {
          family,
          messages: vi.fn(async () => []),
          statuses: vi.fn(async () => [
            { conversationId: worker.conversationId, state: 'waiting', since: 1 },
            // A chat outside the family is ignored.
            { conversationId: 'stranger', state: 'working', since: 1 }
          ]),
          onChanged: (callback: (change: SessionsChangedEvent) => void) => {
            emit = callback
            return () => undefined
          }
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

  it('knows a chat’s role and applies state changes without reloading the family', async () => {
    await act(async () => root.render(<Probe id={worker.conversationId} />))
    await act(async () => undefined)
    expect(latest?.role).toBe('worker')
    expect(latest?.self?.conversationId).toBe(worker.conversationId)
    expect([...latest!.statuses.keys()]).toEqual([worker.conversationId])
    expect(family).toHaveBeenCalledTimes(1)

    await act(async () =>
      emit({
        kind: 'status',
        conversationIds: [worker.conversationId],
        statuses: [{ conversationId: worker.conversationId, state: 'done', since: 2 }]
      })
    )
    expect(latest?.self?.state).toBe('done')
    expect(latest?.family?.workers[0].state).toBe('done')
    expect(family).toHaveBeenCalledTimes(1)

    // A family change elsewhere is not this chat's business.
    await act(async () => emit({ kind: 'family', conversationIds: ['stranger'] }))
    expect(family).toHaveBeenCalledTimes(1)
    await act(async () => emit({ kind: 'family', conversationIds: ['manager'] }))
    await act(async () => undefined)
    expect(family).toHaveBeenCalledTimes(2)
  })

  it('is empty for a chat with no family', async () => {
    family.mockResolvedValue(null)
    await act(async () => root.render(<Probe id="alone" />))
    await act(async () => undefined)
    expect(latest?.role).toBeNull()
    expect(latest?.family).toBeNull()
  })
})

describe('familyProjectTag', () => {
  it('tags only a worker whose project is not the manager’s, even through a worktree', () => {
    expect(familyProjectTag(worker, manager)).toBeNull()
    const elsewhere = familyMember('api', {
      projectId: 'p-api',
      projectName: 'sidekick-api · sidekick/api'
    })
    expect(familyProjectTag(elsewhere, manager)).toBe('sidekick-api')
    expect(familyProjectTag(manager, manager)).toBeNull()
  })
})
