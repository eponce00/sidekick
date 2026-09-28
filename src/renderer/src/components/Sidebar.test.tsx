// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Sidebar from './Sidebar'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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

  it('creates a standalone chat from the Chats heading action', async () => {
    const onNewConversation = vi.fn()
    await act(async () => {
      root.render(
        <Sidebar
          conversations={[]}
          projects={[]}
          groups={[]}
          currentConversationId={null}
          currentGroupId={null}
          currentGroupSessionId={null}
          isCollapsed={false}
          busyConversationIds={new Set()}
          unreadConversationIds={new Set()}
          onSelectConversation={vi.fn()}
          onSelectGroup={vi.fn()}
          onSelectGroupSession={vi.fn()}
          onToggleCollapsed={vi.fn()}
          onNewConversation={onNewConversation}
          onNewGroup={vi.fn()}
          onOpenProject={vi.fn()}
          onDeleteConversation={vi.fn()}
          onDeleteGroup={vi.fn()}
          onDeleteAllConversations={vi.fn()}
          onForkConversation={vi.fn()}
          onRenameConversation={vi.fn()}
          onRenameGroup={vi.fn()}
          onRenameGroupSession={vi.fn()}
          onMoveConversation={vi.fn()}
          onRenameProject={vi.fn()}
          onToggleConversationPin={vi.fn()}
          onToggleProjectPin={vi.fn()}
          onRemoveProject={vi.fn()}
        />
      )
    })

    const button = container.querySelector(
      'button[aria-label="New standalone chat"]'
    ) as HTMLButtonElement
    expect(button).not.toBeNull()
    await act(async () => button.click())
    expect(onNewConversation).toHaveBeenCalledOnce()
    expect(onNewConversation).toHaveBeenCalledWith(null)
  })

  it('keeps chat deletion beside the overflow menu', async () => {
    const onDeleteConversation = vi.fn()
    await act(async () => {
      root.render(
        <Sidebar
          conversations={[
            {
              id: 'chat-1',
              title: 'Planning chat',
              created_at: 1,
              updated_at: 1,
              project_id: null,
              sidebar_order: 0,
              project_context_version: 0,
              home_workspace_root: null,
              home_project_name: null
            }
          ]}
          projects={[]}
          groups={[]}
          currentConversationId={null}
          currentGroupId={null}
          currentGroupSessionId={null}
          isCollapsed={false}
          busyConversationIds={new Set()}
          unreadConversationIds={new Set()}
          onSelectConversation={vi.fn()}
          onSelectGroup={vi.fn()}
          onSelectGroupSession={vi.fn()}
          onToggleCollapsed={vi.fn()}
          onNewConversation={vi.fn()}
          onNewGroup={vi.fn()}
          onOpenProject={vi.fn()}
          onDeleteConversation={onDeleteConversation}
          onDeleteGroup={vi.fn()}
          onDeleteAllConversations={vi.fn()}
          onForkConversation={vi.fn()}
          onRenameConversation={vi.fn()}
          onRenameGroup={vi.fn()}
          onRenameGroupSession={vi.fn()}
          onMoveConversation={vi.fn()}
          onRenameProject={vi.fn()}
          onToggleConversationPin={vi.fn()}
          onToggleProjectPin={vi.fn()}
          onRemoveProject={vi.fn()}
        />
      )
    })

    const deleteButton = container.querySelector(
      'button[aria-label="Delete Planning chat"]'
    ) as HTMLButtonElement
    const actionsButton = container.querySelector(
      'button[aria-label="Actions for Planning chat"]'
    ) as HTMLButtonElement
    const actions = deleteButton.closest('.conversation-actions')

    expect(deleteButton).not.toBeNull()
    expect(actionsButton).not.toBeNull()
    expect(actions?.firstElementChild).toBe(deleteButton)

    await act(async () => actionsButton.click())
    expect(container.querySelector('[role="menu"]')?.textContent).not.toContain('Delete')

    await act(async () => deleteButton.click())
    expect(container.textContent).toContain('Delete conversation?')

    const confirmButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Delete'
    ) as HTMLButtonElement
    await act(async () => confirmButton.click())
    expect(onDeleteConversation).toHaveBeenCalledWith('chat-1')
  })

  it('shows working chats as animated and completed unread chats as solid', async () => {
    const conversations = ['working-chat', 'unread-chat'].map((id, index) => ({
      id,
      title: id,
      created_at: index + 1,
      updated_at: index + 1,
      project_id: null,
      sidebar_order: index,
      project_context_version: 0,
      home_workspace_root: null,
      home_project_name: null
    }))
    await act(async () => {
      root.render(
        <Sidebar
          conversations={conversations}
          projects={[]}
          groups={[]}
          currentConversationId={null}
          currentGroupId={null}
          currentGroupSessionId={null}
          isCollapsed={false}
          busyConversationIds={new Set(['working-chat'])}
          unreadConversationIds={new Set(['working-chat', 'unread-chat'])}
          onSelectConversation={vi.fn()}
          onSelectGroup={vi.fn()}
          onSelectGroupSession={vi.fn()}
          onToggleCollapsed={vi.fn()}
          onNewConversation={vi.fn()}
          onNewGroup={vi.fn()}
          onOpenProject={vi.fn()}
          onDeleteConversation={vi.fn()}
          onDeleteGroup={vi.fn()}
          onDeleteAllConversations={vi.fn()}
          onForkConversation={vi.fn()}
          onRenameConversation={vi.fn()}
          onRenameGroup={vi.fn()}
          onRenameGroupSession={vi.fn()}
          onMoveConversation={vi.fn()}
          onRenameProject={vi.fn()}
          onToggleConversationPin={vi.fn()}
          onToggleProjectPin={vi.fn()}
          onRemoveProject={vi.fn()}
        />
      )
    })

    expect(
      container.querySelector('[aria-label="Agent working in background"]')?.classList
    ).toContain('working')
    expect(
      container.querySelector('[aria-label="Completed response unread"]')?.classList
    ).toContain('unread')
  })

  it('marks a chat waiting on the user above working', async () => {
    const conversations = ['waiting-chat', 'working-chat'].map((id, index) => ({
      id,
      title: id,
      created_at: index + 1,
      updated_at: index + 1,
      project_id: null,
      sidebar_order: index,
      project_context_version: 0,
      home_workspace_root: null,
      home_project_name: null
    }))
    await act(async () => {
      root.render(
        <Sidebar
          conversations={conversations}
          projects={[]}
          groups={[]}
          currentConversationId={null}
          currentGroupId={null}
          currentGroupSessionId={null}
          isCollapsed={false}
          busyConversationIds={new Set(['waiting-chat', 'working-chat'])}
          unreadConversationIds={new Set()}
          waitingConversationIds={new Set(['waiting-chat'])}
          onSelectConversation={vi.fn()}
          onSelectGroup={vi.fn()}
          onSelectGroupSession={vi.fn()}
          onToggleCollapsed={vi.fn()}
          onNewConversation={vi.fn()}
          onNewGroup={vi.fn()}
          onOpenProject={vi.fn()}
          onDeleteConversation={vi.fn()}
          onDeleteGroup={vi.fn()}
          onDeleteAllConversations={vi.fn()}
          onForkConversation={vi.fn()}
          onRenameConversation={vi.fn()}
          onRenameGroup={vi.fn()}
          onRenameGroupSession={vi.fn()}
          onMoveConversation={vi.fn()}
          onRenameProject={vi.fn()}
          onToggleConversationPin={vi.fn()}
          onToggleProjectPin={vi.fn()}
          onRemoveProject={vi.fn()}
        />
      )
    })

    const indicators = [...container.querySelectorAll('.conversation-run-indicator')]
    expect(indicators.map((indicator) => indicator.className)).toEqual([
      'conversation-run-indicator waiting',
      'conversation-run-indicator working'
    ])
    expect(indicators[0].getAttribute('aria-label')).toBe('Waiting for your approval or answer')
  })

  it('reports the conversations in the order it lists them, skipping collapsed projects', async () => {
    const chat = (id: string, projectId: string | null) => ({
      id,
      title: id,
      created_at: 1,
      updated_at: 1,
      project_id: projectId,
      sidebar_order: 0,
      project_context_version: 0,
      home_workspace_root: null,
      home_project_name: null
    })
    const onOrder = vi.fn()
    vi.mocked(window.localStorage.getItem).mockImplementation((key: string) =>
      key === 'collapsedProjectIds' ? JSON.stringify(['hidden']) : null
    )
    await act(async () => {
      root.render(
        <Sidebar
          conversations={[
            chat('loose', null),
            chat('in-hidden', 'hidden'),
            chat('in-open', 'open')
          ]}
          projects={['open', 'hidden'].map((id) => ({
            id,
            name: id,
            folder_path: `/${id}`,
            is_pinned: 0,
            created_at: 1,
            updated_at: 1
          }))}
          groups={[]}
          currentConversationId={null}
          currentGroupId={null}
          currentGroupSessionId={null}
          isCollapsed={false}
          busyConversationIds={new Set()}
          unreadConversationIds={new Set()}
          onSelectConversation={vi.fn()}
          onSelectGroup={vi.fn()}
          onSelectGroupSession={vi.fn()}
          onToggleCollapsed={vi.fn()}
          onNewConversation={vi.fn()}
          onNewGroup={vi.fn()}
          onOpenProject={vi.fn()}
          onDeleteConversation={vi.fn()}
          onDeleteGroup={vi.fn()}
          onDeleteAllConversations={vi.fn()}
          onForkConversation={vi.fn()}
          onRenameConversation={vi.fn()}
          onRenameGroup={vi.fn()}
          onRenameGroupSession={vi.fn()}
          onMoveConversation={vi.fn()}
          onRenameProject={vi.fn()}
          onToggleConversationPin={vi.fn()}
          onToggleProjectPin={vi.fn()}
          onRemoveProject={vi.fn()}
          onVisibleConversationOrderChange={onOrder}
        />
      )
    })

    expect(onOrder).toHaveBeenLastCalledWith(['in-open', 'loose'])
  })
})
