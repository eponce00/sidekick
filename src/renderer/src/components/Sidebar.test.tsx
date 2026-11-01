// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Project } from '../types/app.types'
import Sidebar from './Sidebar'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const chat = (id: string, projectId: string | null = null, updatedAt = 1): Conversation => ({
  id,
  title: id,
  created_at: 1,
  updated_at: updatedAt,
  project_id: projectId,
  sidebar_order: 0,
  project_context_version: 0,
  home_workspace_root: null,
  home_project_name: null
})

const project = (id: string): Project => ({
  id,
  name: `${id} folder`,
  folder_path: `/${id}`,
  is_pinned: 0,
  created_at: 1,
  updated_at: 1
})

describe('Sidebar chat section', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn()
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

  const renderSidebar = async (
    props: Partial<React.ComponentProps<typeof Sidebar>> & {
      conversations: Conversation[]
      projects?: Project[]
    }
  ): Promise<void> => {
    await act(async () => {
      root.render(
        <Sidebar
          projects={[]}
          currentConversationId={null}
          isCollapsed={false}
          busyConversationIds={new Set()}
          unreadConversationIds={new Set()}
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
          {...props}
        />
      )
    })
  }
  const click = async (selector: string): Promise<void> => {
    const element = container.querySelector<HTMLElement>(selector)
    expect(element, selector).not.toBeNull()
    await act(async () => element!.click())
  }

  it('deletes a chat only after the user confirms', async () => {
    const onDeleteConversation = vi.fn()
    await renderSidebar({ conversations: [chat('chat-1')], onDeleteConversation })

    await click('button[aria-label="Delete chat-1"]')
    expect(onDeleteConversation).not.toHaveBeenCalled()

    const confirmButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Delete'
    ) as HTMLButtonElement
    await act(async () => confirmButton.click())
    expect(onDeleteConversation).toHaveBeenCalledWith('chat-1')
  })

  it('marks a chat waiting on the user above working, and working above unread', async () => {
    await renderSidebar({
      conversations: [chat('waiting-chat'), chat('working-chat'), chat('unread-chat')],
      busyConversationIds: new Set(['waiting-chat', 'working-chat']),
      unreadConversationIds: new Set(['working-chat', 'unread-chat']),
      waitingConversationIds: new Set(['waiting-chat'])
    })

    const indicators = [...container.querySelectorAll('.conversation-run-indicator')]
    expect(indicators.map((indicator) => indicator.className)).toEqual([
      'conversation-run-indicator waiting',
      'conversation-run-indicator working',
      'conversation-run-indicator unread'
    ])
  })

  it('reports the conversations in the order it lists them, skipping collapsed projects', async () => {
    const onOrder = vi.fn()
    vi.mocked(window.localStorage.getItem).mockImplementation((key: string) =>
      key === 'collapsedProjectIds' ? JSON.stringify(['hidden']) : null
    )
    await renderSidebar({
      conversations: [chat('loose'), chat('in-hidden', 'hidden'), chat('in-open', 'open')],
      projects: [project('open'), project('hidden')],
      onVisibleConversationOrderChange: onOrder
    })

    expect(onOrder).toHaveBeenLastCalledWith(['in-open', 'loose'])

    // A closed section hides its rows and leaves keyboard order.
    const toggle = (label: string): HTMLButtonElement =>
      [...container.querySelectorAll<HTMLButtonElement>('.sidebar-section-toggle')].find((button) =>
        button.textContent?.startsWith(label)
      )!
    await act(async () => toggle('Chats').click())
    expect(container.textContent).not.toContain('loose')
    expect(onOrder).toHaveBeenLastCalledWith(['in-open'])
    expect(window.localStorage.setItem).toHaveBeenLastCalledWith(
      'collapsedSidebarSections',
      JSON.stringify(['chats'])
    )

    await act(async () => toggle('Projects').click())
    expect(onOrder).toHaveBeenLastCalledWith([])

    await act(async () => toggle('Chats').click())
    expect(onOrder).toHaveBeenLastCalledWith(['loose'])
  })

  it('shows only chats waiting on the user, even inside a closed project', async () => {
    vi.mocked(window.localStorage.getItem).mockImplementation((key: string) =>
      key === 'collapsedProjectIds' ? JSON.stringify(['closed']) : null
    )
    const onOrder = vi.fn()
    await renderSidebar({
      conversations: [
        chat('waiting-in-closed', 'closed', 3),
        chat('working-loose', null, 2),
        chat('idle-loose', null, 1)
      ],
      projects: [project('closed')],
      busyConversationIds: new Set(['waiting-in-closed', 'working-loose']),
      waitingConversationIds: new Set(['waiting-in-closed']),
      onVisibleConversationOrderChange: onOrder
    })
    expect(container.textContent).not.toContain('waiting-in-closed')

    await click('button[aria-label="Filter chats"]')
    const needsAttention = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    ].find((option) => option.textContent?.startsWith('Needs attention'))!
    await act(async () => needsAttention.click())

    expect(container.textContent).toContain('waiting-in-closed')
    expect(container.textContent).not.toContain('working-loose')
    expect(container.textContent).not.toContain('idle-loose')
    expect(onOrder).toHaveBeenLastCalledWith(['waiting-in-closed'])
    // A filter is never remembered across launches.
    expect(window.localStorage.setItem).not.toHaveBeenCalledWith(
      expect.stringMatching(/filter/i),
      expect.anything()
    )

    await click('button[aria-label="Show all chats"]')
    expect(container.textContent).toContain('idle-loose')
    expect(container.textContent).not.toContain('waiting-in-closed')
  })

  it('lists chats across folders by recent activity and remembers the view', async () => {
    // Midday, so "a second ago" is always still today.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 16, 12))
    try {
      const now = Date.now()
      const onOrder = vi.fn()
      await renderSidebar({
        conversations: [
          chat('older-in-a', 'a', now - 10 * 86_400_000),
          chat('loose-now', null, now),
          chat('in-b-now', 'b', now - 1_000)
        ],
        projects: [project('a'), project('b')],
        onVisibleConversationOrderChange: onOrder
      })
      expect(onOrder).toHaveBeenLastCalledWith(['older-in-a', 'in-b-now', 'loose-now'])

      await click('.sidebar-view-toggle')
      expect(
        [...container.querySelectorAll('.sidebar-section-label')].map((label) => label.textContent)
      ).toEqual(['Today', 'Older'])
      expect(onOrder).toHaveBeenLastCalledWith(['loose-now', 'in-b-now', 'older-in-a'])
      // Time decides the order here, so rows cannot be dragged into one.
      expect(
        [...container.querySelectorAll('.conversation-item')].every(
          (row) => row.getAttribute('draggable') === 'false'
        )
      ).toBe(true)
      expect(window.localStorage.setItem).toHaveBeenCalledWith('sidebarView', 'recent')

      await click('.sidebar-view-toggle')
      expect(onOrder).toHaveBeenLastCalledWith(['older-in-a', 'in-b-now', 'loose-now'])

      await act(async () => root.unmount())
      root = createRoot(container)
      vi.mocked(window.localStorage.getItem).mockImplementation((key: string) =>
        key === 'sidebarView' ? 'recent' : null
      )
      await renderSidebar({ conversations: [chat('loose-now', null, now)] })
      expect(container.querySelector('.sidebar-view-toggle')?.getAttribute('data-view')).toBe(
        'recent'
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
