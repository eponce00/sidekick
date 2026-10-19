// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionStatus } from '../../../shared/sessions'
import type { Conversation, Project } from '../types/app.types'
import Sidebar from './Sidebar'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project = (id: string, name: string): Project => ({
  id,
  name,
  folder_path: `C:\\${name}`,
  is_pinned: 0,
  created_at: 1,
  updated_at: 1
})

function chat(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: id,
    created_at: 1,
    updated_at: 1,
    project_id: 'p1',
    sidebar_order: 0,
    project_context_version: 0,
    home_workspace_root: 'C:\\alpha',
    home_project_name: 'alpha',
    ...overrides
  }
}

const worker = (handle: string, created: number, projectId = 'p1'): Conversation =>
  chat(`w-${handle}`, {
    title: `Worker ${handle}`,
    created_at: created,
    project_id: projectId,
    started_by_kind: 'session',
    started_by_conversation_id: 'manager',
    report_to_conversation_id: 'manager',
    session_handle: handle
  })

const family = [
  chat('manager', { title: 'Design review' }),
  worker('cards', 1),
  worker('toggle', 2),
  worker('api', 3, 'p2'),
  chat('other', { title: 'Other chat' })
]

describe('Sidebar chat families', () => {
  let container: HTMLDivElement
  let root: Root
  let storage: Map<string, string>

  beforeEach(() => {
    storage = new Map()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
        removeItem: vi.fn(),
        clear: vi.fn()
      }
    })
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const render = async (
    props: {
      conversations?: Conversation[]
      waiting?: Set<string>
      busy?: Set<string>
      unread?: Set<string>
      onOrder?: (ids: string[]) => void
      sessionStatuses?: ReadonlyMap<string, SessionStatus>
      projects?: Project[]
    } = {}
  ): Promise<void> => {
    await act(async () => {
      root.render(
        <Sidebar
          sessionStatuses={props.sessionStatuses}
          conversations={props.conversations ?? family}
          projects={props.projects ?? [project('p1', 'alpha'), project('p2', 'beta')]}
          currentConversationId={null}
          isCollapsed={false}
          busyConversationIds={props.busy ?? new Set()}
          unreadConversationIds={props.unread ?? new Set()}
          waitingConversationIds={props.waiting}
          onSelectConversation={vi.fn()}
          onToggleCollapsed={vi.fn()}
          onNewConversation={vi.fn()}
          onOpenProject={vi.fn()}
          onOpenCommandPalette={vi.fn()}
          platform="windows"
          onDeleteConversation={vi.fn()}
          onDeleteAllConversations={vi.fn()}
          onForkConversation={vi.fn()}
          onRenameConversation={vi.fn()}
          onMoveConversation={vi.fn()}
          onRenameProject={vi.fn()}
          onToggleConversationPin={vi.fn()}
          onToggleProjectPin={vi.fn()}
          onRemoveProject={vi.fn()}
          onVisibleConversationOrderChange={props.onOrder}
        />
      )
    })
  }

  const row = (title: string): HTMLElement =>
    [...container.querySelectorAll<HTMLElement>('.conversation-item')].find(
      (item) => item.querySelector('.conversation-title')?.textContent === title
    )!
  const titles = (): string[] =>
    [...container.querySelectorAll('.conversation-title')].map((node) => node.textContent ?? '')

  it('lists a chat in its own worktree under its project, marked with a branch icon', async () => {
    await render({
      conversations: [
        chat('manager', { title: 'Design review' }),
        { ...worker('cards', 1, 'p1'), worktree_id: 'wt-alpha' },
        { ...worker('api', 2, 'p2'), worktree_id: 'wt-beta' }
      ]
    })
    // Same project as the manager: no tag. Another project: tagged with that name.
    expect(row('cards').querySelector('.session-project-tag')).toBeNull()
    expect(row('api').querySelector('.session-project-tag')?.textContent).toBe('beta')
    expect(row('cards').querySelector('.conversation-worktree-icon')).not.toBeNull()
    expect(row('Design review').querySelector('.conversation-worktree-icon')).toBeNull()
    expect(
      [...container.querySelectorAll('.project-name')].map((node) => node.textContent)
    ).toEqual(['alpha', 'beta'])
  })

  it('nests workers under their manager by handle, with a tag for one in another project', async () => {
    await render()
    expect(titles()).toEqual(['Design review', 'cards', 'toggle', 'api', 'Other chat'])
    const workers = container.querySelector('.session-family-workers')!
    expect(workers.querySelectorAll('.session-worker')).toHaveLength(3)
    expect(row('api').querySelector('.session-project-tag')?.textContent).toBe('beta')
    expect(row('cards').querySelector('.session-project-tag')).toBeNull()
    // The other project does not list the worker a second time.
    const beta = [...container.querySelectorAll('.project-name')].find(
      (node) => node.textContent === 'beta'
    )
    expect(
      beta?.closest('.project-group')?.querySelectorAll('.conversation-item') ?? []
    ).toHaveLength(0)
  })

  it('shows each row its own mark, a summary on the manager, and a worker waiting on the manager too', async () => {
    await render({
      waiting: new Set(['w-api']),
      busy: new Set(['w-toggle']),
      unread: new Set(['w-cards'])
    })
    expect(row('toggle').querySelector('.conversation-run-indicator')?.className).toContain(
      'working'
    )
    expect(row('cards').querySelector('.conversation-run-indicator')?.className).toContain('unread')
    expect(row('Design review').querySelector('.conversation-run-indicator')?.className).toContain(
      'waiting'
    )
    expect(row('Design review').querySelector('.session-roll-up')?.textContent).toBe(
      '1 needs you · 1 working · 1 done'
    )
  })

  it('rolls a collapsed family up onto its manager and remembers the choice', async () => {
    await render({ busy: new Set(['w-toggle']) })
    expect(row('Design review').querySelector('.conversation-run-indicator')).toBeNull()
    const toggle = container.querySelector<HTMLButtonElement>('.session-family-toggle')!
    await act(async () => toggle.click())
    expect(titles()).toEqual(['Design review', 'Other chat'])
    expect(row('Design review').querySelector('.conversation-run-indicator')?.className).toContain(
      'working'
    )
    expect(storage.get('collapsedSessionFamilies')).toBe('["manager"]')

    await act(async () => root.unmount())
    root = createRoot(container)
    await render({ busy: new Set(['w-toggle']) })
    expect(titles()).toEqual(['Design review', 'Other chat'])
  })

  it('lists matching workers with their manager as context when filtering', async () => {
    await render({ unread: new Set(['w-cards']) })
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Filter chats"]')!.click()
    )
    const unread = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.startsWith('Unread')
    )!
    await act(async () => unread.click())
    expect(titles()).toEqual(['Design review', 'cards'])
    expect(row('Design review').classList.contains('is-context')).toBe(true)
    expect(row('cards').classList.contains('is-context')).toBe(false)
  })

  it('moves through rows in the order they are shown', async () => {
    const onOrder = vi.fn()
    await render({ onOrder })
    expect(onOrder).toHaveBeenLastCalledWith(['manager', 'w-cards', 'w-toggle', 'w-api', 'other'])
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.session-family-toggle')!.click()
    )
    expect(onOrder).toHaveBeenLastCalledWith(['manager', 'other'])
  })

  it('drags a manager with its family and never a worker on its own', async () => {
    await render()
    expect(row('Design review').getAttribute('draggable')).toBe('true')
    expect(row('cards').getAttribute('draggable')).toBe('false')
  })

  it('shows the main process states it is given, and hides archived chats', async () => {
    const statuses: SessionStatus[] = [
      { conversationId: 'w-toggle', state: 'failed', since: 1 },
      { conversationId: 'w-cards', state: 'queued', since: 1 }
    ]
    await render({
      conversations: [...family, chat('old', { archived_at: 5 })],
      sessionStatuses: new Map(statuses.map((status) => [status.conversationId, status]))
    })
    expect(row('toggle').querySelector('.conversation-run-indicator')?.className).toContain(
      'failed'
    )
    expect(row('cards').querySelector('.conversation-run-indicator')?.className).toContain('queued')
    expect(titles()).not.toContain('old')
  })
})
