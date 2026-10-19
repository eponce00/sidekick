// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Project } from '../types/app.types'
import Sidebar from './Sidebar'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: Project = {
  id: 'p1',
  name: 'alpha',
  folder_path: 'C:\\alpha',
  is_pinned: 0,
  created_at: 1,
  updated_at: 1
}

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

const scheduled = (run: number): Conversation =>
  chat(`run-${run}`, {
    title: `Morning check · Run ${run}`,
    created_at: run,
    schedule_id: 'schedule-1',
    schedule_run_number: run
  })

describe('Sidebar scheduled runs', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const render = async (props: {
    conversations: Conversation[]
    currentConversationId?: string | null
    waiting?: Set<string>
    onSelectConversation?: (id: string) => void
    onOpenSchedules?: () => void
    collapsed?: boolean
  }): Promise<void> => {
    await act(async () => {
      root.render(
        <Sidebar
          conversations={props.conversations}
          projects={[project]}
          currentConversationId={props.currentConversationId ?? null}
          isCollapsed={props.collapsed ?? false}
          busyConversationIds={new Set()}
          unreadConversationIds={new Set()}
          waitingConversationIds={props.waiting}
          onSelectConversation={props.onSelectConversation ?? vi.fn()}
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
          scheduleNames={new Map([['schedule-1', 'Morning check']])}
          onOpenSchedules={props.onOpenSchedules}
        />
      )
    })
  }

  const titles = (): string[] =>
    [...container.querySelectorAll('.conversation-title')].map((node) => node.textContent ?? '')

  it('collapses one schedule into a row with its run count that opens to Run N rows', async () => {
    const onSelectConversation = vi.fn()
    await render({
      conversations: [chat('mine'), scheduled(1), scheduled(2)],
      onSelectConversation
    })
    expect(titles()).toEqual(['mine', 'Morning check'])
    const row = container.querySelector('.scheduled-run-group-row') as HTMLButtonElement
    expect(row.textContent).toContain('2 runs')
    expect(row.getAttribute('aria-expanded')).toBe('false')

    await act(async () => row.click())
    expect(titles()).toEqual(['mine', 'Morning check', 'Run 2', 'Run 1'])
    const runOne = [...container.querySelectorAll('.conversation-select-button')].find((node) =>
      node.textContent?.includes('Run 1')
    ) as HTMLButtonElement
    await act(async () => runOne.click())
    expect(onSelectConversation).toHaveBeenCalledWith('run-1')
  })

  it('opens the group that holds the shown chat and marks it when a run waits for approval', async () => {
    await render({
      conversations: [scheduled(1), scheduled(2)],
      currentConversationId: 'run-1',
      waiting: new Set(['run-2'])
    })
    expect(titles()).toEqual(['Morning check', 'Run 2', 'Run 1'])
    const indicator = container.querySelector(
      '.scheduled-run-group-row .conversation-run-indicator'
    )
    expect(indicator?.classList.contains('waiting')).toBe(true)
  })

  it('opens Schedules from the header', async () => {
    const onOpenSchedules = vi.fn()
    await render({ conversations: [], onOpenSchedules })
    const button = container.querySelector('button[aria-label="Schedules"]') as HTMLButtonElement
    await act(async () => button.click())
    expect(onOpenSchedules).toHaveBeenCalledOnce()
  })

  it('lists Schedules with the places in the collapsed rail, and keeps More at its foot', async () => {
    const onOpenSchedules = vi.fn()
    await render({
      conversations: [chat('loose', { project_id: null })],
      onOpenSchedules,
      collapsed: true
    })
    const header = container.querySelector('.sidebar-header')!
    // Nothing sits beside the expand button any more.
    expect(header.querySelector('button[aria-label="Schedules"]')).toBeNull()
    expect(header.querySelector('button[aria-label="More"]')).toBeNull()
    const nav = container.querySelector('.collapsed-sidebar-nav')!
    expect(
      [...nav.querySelectorAll('button')].map((button) => button.getAttribute('title'))
    ).toEqual(['Projects (1)', 'Standalone chats (1)', 'Schedules'])
    await act(async () =>
      nav.querySelector<HTMLButtonElement>('button[aria-label="Schedules"]')!.click()
    )
    expect(onOpenSchedules).toHaveBeenCalledOnce()
    expect(container.querySelector('.sidebar-rail-footer button[aria-label="More"]')).not.toBeNull()
  })
})
