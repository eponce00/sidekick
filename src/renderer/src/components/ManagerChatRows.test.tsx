// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FamilyStrip, ReceivedMessagesRow, StartedChatsRow } from './ManagerChatRows'
import { SessionTodoList } from './SessionTodoList'
import { familyMember, familyMessage, statusMap } from './sessionTestFixtures'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const manager = familyMember(null)
const schedules = familyMember('schedules', { state: 'working' })
const api = familyMember('api-contract', {
  state: 'working',
  projectId: 'project-api',
  projectName: 'sidekick-api · sidekick/api-contract'
})
const members = new Map([manager, schedules, api].map((m) => [m.conversationId, m]))

describe('manager chat rows', () => {
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

  const button = (label: string): HTMLButtonElement =>
    [...container.querySelectorAll('button')].find((item) =>
      (item.getAttribute('aria-label') ?? item.textContent ?? '').includes(label)
    )!

  it('lists the chats it started with live states, tagging one in another project', async () => {
    const onOpenChat = vi.fn()
    await act(async () =>
      root.render(
        <StartedChatsRow
          briefs={[
            familyMessage('b1', 'manager', schedules.conversationId, 'brief'),
            familyMessage('b2', 'manager', api.conversationId, 'brief')
          ]}
          members={members}
          // The live status wins over the family snapshot.
          statuses={statusMap([[schedules.conversationId, 'waiting']])}
          manager={manager}
          onOpenChat={onOpenChat}
        />
      )
    )
    expect(container.querySelector('.session-dot-waiting')).not.toBeNull()
    // The worktree of the manager's own project has no tag; another project does.
    const tags = [...container.querySelectorAll('.session-chip-project')].map((t) => t.textContent)
    expect(tags).toEqual(['sidekick-api'])
    await act(async () => button('Open api-contract').click())
    expect(onOpenChat).toHaveBeenCalledWith(api.conversationId)
  })

  it('folds received messages into one row that expands to each sender and a way to them', async () => {
    const onOpenChat = vi.fn()
    await act(async () =>
      root.render(
        <ReceivedMessagesRow
          messages={[
            familyMessage(
              'm1',
              schedules.conversationId,
              'manager',
              'status',
              'Waiting for approval.\nMore detail'
            ),
            familyMessage('m2', api.conversationId, 'manager', 'report', 'Done. 14 tests pass.')
          ]}
          members={members}
          statuses={statusMap([
            [schedules.conversationId, 'waiting'],
            [api.conversationId, 'done']
          ])}
          manager={manager}
          onOpenChat={onOpenChat}
        />
      )
    )
    const toggle = container.querySelector('.family-received-toggle') as HTMLButtonElement
    expect(container.querySelector('.family-received-list')).toBeNull()

    await act(async () => toggle.click())
    const lines = [...container.querySelectorAll('.family-received-list li')]
    expect(lines).toHaveLength(2)
    expect(lines[0].textContent).not.toContain('More detail')
    // A sender waiting on the user is a jump to its approval, not just a chat to open.
    await act(async () => button('Go to approval').click())
    expect(onOpenChat).toHaveBeenCalledWith(schedules.conversationId)
  })

  it('stops the active chats only after a second confirmation', async () => {
    const onStopAll = vi.fn()
    const done = familyMember('question-card', { state: 'done' })
    await act(async () =>
      root.render(
        <FamilyStrip
          workers={[schedules, api, done]}
          statuses={statusMap([[schedules.conversationId, 'waiting']])}
          onStopAll={onStopAll}
        />
      )
    )
    await act(async () => button('Stop all').click())
    expect(onStopAll).not.toHaveBeenCalled()
    await act(async () => button('Keep running').click())

    await act(async () => button('Stop all').click())
    await act(async () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Stop')!.click()
    )
    expect(onStopAll).toHaveBeenCalledWith([schedules.conversationId, api.conversationId])
  })

  it('offers no Stop all when nothing is running', async () => {
    await act(async () =>
      root.render(
        <FamilyStrip
          workers={[familyMember('question-card', { state: 'done' })]}
          statuses={new Map()}
          onStopAll={vi.fn()}
        />
      )
    )
    expect(button('Stop all')).toBeUndefined()
  })

  it('links a task step to its chat while that chat is still in the family', async () => {
    const onOpenChat = vi.fn()
    await act(async () =>
      root.render(
        <SessionTodoList
          todos={[
            { id: 1, title: 'Read the setup', description: '', status: 'completed' },
            {
              id: 2,
              title: 'Port schedules',
              description: '',
              status: 'not-started',
              sessionId: schedules.conversationId
            },
            {
              id: 3,
              title: 'Gone chat',
              description: '',
              status: 'not-started',
              sessionId: 'worker-archived'
            },
            { id: 4, title: 'Write it up', description: '', status: 'in-progress' }
          ]}
          members={members}
          statuses={statusMap([[schedules.conversationId, 'waiting']])}
          manager={manager}
          onOpenChat={onOpenChat}
        />
      )
    )
    const steps = [...container.querySelectorAll('.family-todo')]
    expect(steps[1].querySelector('.session-chip')).not.toBeNull()
    // A step whose chat is no longer in the family has no chip.
    expect(steps[2].querySelector('.session-chip')).toBeNull()
    await act(async () => button('Open schedules').click())
    expect(onOpenChat).toHaveBeenCalledWith(schedules.conversationId)
  })
})
