// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedWorktreeSummary } from '../../../shared/worktrees'
import { ChatsPanel } from './ChatsPanel'
import { familyMember, familyMessage, statusMap } from './sessionTestFixtures'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const manager = familyMember(null)
const schedules = familyMember('schedules', { state: 'working' })
const done = familyMember('question-card', { state: 'done', reportToConversationId: null })
const family = { rootConversationId: 'manager', manager, workers: [schedules, done] }

const worktree = (owner: string, ahead: number, changedFiles: number): ManagedWorktreeSummary =>
  ({
    id: `wt-${owner}`,
    branch: `sidekick/${owner.replace('worker-', '')}`,
    baseRef: 'main',
    owners: [{ kind: 'chat', id: owner, title: owner, running: false }],
    status: { currentBranch: null, ahead, changedFiles }
  }) as ManagedWorktreeSummary

const worktrees = [worktree(schedules.conversationId, 3, 4), worktree(done.conversationId, 1, 0)]

describe('ChatsPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const button = (scope: Element, label: string): HTMLButtonElement =>
    [...scope.querySelectorAll('button')].find((item) => item.textContent === label)!

  it('lists a manager’s chats with state, branch and actions', async () => {
    const onOpenChat = vi.fn()
    const onMessageChat = vi.fn()
    const onStop = vi.fn()
    await act(async () =>
      root.render(
        <ChatsPanel
          conversationId="manager"
          view={{
            family,
            role: 'manager',
            self: manager,
            messages: [],
            statuses: statusMap([[schedules.conversationId, 'waiting', 'Approval: run npm test']])
          }}
          worktrees={worktrees}
          onOpenChat={onOpenChat}
          onMessageChat={onMessageChat}
          onStop={onStop}
          onDetach={vi.fn()}
        />
      )
    )
    const cards = [...container.querySelectorAll('.chats-panel-card')]
    expect(cards).toHaveLength(2)
    expect(container.querySelector('.chats-panel-heading')?.textContent).toBe(
      'Started by this chat 2'
    )
    const [waiting, finished] = cards
    expect(waiting.querySelector('.chats-panel-state')?.textContent).toBe('Needs you')
    expect(waiting.querySelector('.chats-panel-reason')?.textContent).toBe('Approval: run npm test')
    expect(waiting.querySelector('.chats-panel-branch')?.textContent).toBe(
      'sidekick/schedules+3 commits4 files changed'
    )
    expect(finished.querySelector('.chats-panel-branch')?.textContent).toBe(
      'sidekick/question-card+1 commitclean'
    )
    // Only a chat still running can be stopped.
    expect(button(finished, 'Stop')).toBeUndefined()
    await act(async () => button(waiting, 'Stop').click())
    expect(onStop).toHaveBeenCalledWith(schedules.conversationId)
    await act(async () => button(waiting, 'Message').click())
    expect(onMessageChat).toHaveBeenCalledWith(schedules.conversationId)
    await act(async () => button(finished, 'Open').click())
    expect(onOpenChat).toHaveBeenCalledWith(done.conversationId)
    expect(container.querySelector('.chats-panel-usage')?.textContent).toContain('2 of 8')
  })

  it('shows a worker its family and itself, and detaches only after confirmation', async () => {
    const onOpenChat = vi.fn()
    const onDetach = vi.fn()
    await act(async () =>
      root.render(
        <ChatsPanel
          conversationId={schedules.conversationId}
          view={{
            family,
            role: 'worker',
            self: schedules,
            messages: [familyMessage('brief', 'manager', schedules.conversationId, 'brief')],
            statuses: new Map()
          }}
          worktrees={worktrees}
          onOpenChat={onOpenChat}
          onMessageChat={vi.fn()}
          onStop={vi.fn()}
          onDetach={onDetach}
        />
      )
    )
    const current = container.querySelector('[aria-current="page"]')
    expect(current?.textContent).toBe('schedules')
    await act(async () => button(container, 'Design review').click())
    expect(onOpenChat).toHaveBeenCalledWith('manager')

    const facts = Object.fromEntries(
      [...container.querySelectorAll('.chats-panel-facts dt')].map((dt) => [
        dt.textContent,
        dt.nextElementSibling?.textContent
      ])
    )
    expect(facts['Started by']).toMatch(/^Design review, /)
    expect(facts['Works in']).toBe('New worktree from main')
    expect(facts.Branch).toBe('sidekick/schedules+3 commits4 files changed')
    expect(facts.Reports).toBe('When idle, to the manager')

    await act(async () => button(container, 'Detach from manager').click())
    expect(onDetach).not.toHaveBeenCalled()
    expect(container.textContent).toContain('will stop reporting to Design review')
    await act(async () => button(container, 'Detach').click())
    expect(onDetach).toHaveBeenCalledWith(schedules.conversationId)
  })

  it('offers no detach to a worker that already stopped reporting', async () => {
    await act(async () =>
      root.render(
        <ChatsPanel
          conversationId={done.conversationId}
          view={{ family, role: 'worker', self: done, messages: [], statuses: new Map() }}
          worktrees={[]}
          onOpenChat={vi.fn()}
          onMessageChat={vi.fn()}
          onStop={vi.fn()}
          onDetach={vi.fn()}
        />
      )
    )
    expect(container.textContent).toContain('Not reported anywhere')
    expect(button(container, 'Detach from manager')).toBeUndefined()
  })
})
