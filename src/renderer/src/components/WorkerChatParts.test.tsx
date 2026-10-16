// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedWorktreeSummary } from '../../../shared/worktrees'
import AgentInteractionCard from './AgentInteractionCard'
import { WorkerChatContext } from './sessionChatContext'
import { workerWorkplace } from '../utils/sessionLabels'
import { BriefCard, SessionMessageRow, WorkerBanner, WorkerChatHeader } from './WorkerChatParts'
import { familyMember, familyMessage } from './sessionTestFixtures'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const manager = familyMember(null)
const worker = familyMember('schedules', { title: "Port Cline's schedules feature" })
const worktree = {
  id: 'wt',
  branch: 'sidekick/schedules',
  sourceProjectName: 'sidekick-demo'
} as ManagedWorktreeSummary

describe('worker chat parts', () => {
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
    [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label))!

  it('leads back to the manager and says how the worker stands and where it works', async () => {
    const onOpenChat = vi.fn()
    const onStop = vi.fn()
    const render = async (state: 'waiting' | 'done'): Promise<void> =>
      act(async () =>
        root.render(
          <WorkerChatHeader
            worker={worker}
            manager={manager}
            state={state}
            reason={state === 'waiting' ? 'Approval: run npm test' : undefined}
            worktree={worktree}
            onOpenChat={onOpenChat}
            onStop={onStop}
          />
        )
      )
    await render('waiting')
    expect(container.querySelector('h2')?.textContent).toBe('schedules')
    expect(container.querySelector('.worker-state')?.getAttribute('aria-label')).toBe(
      'State: Needs you. Approval: run npm test'
    )
    expect(container.querySelector('.worker-header-branch')?.textContent).toBe(
      'sidekick/schedules (worktree of sidekick-demo)'
    )
    await act(async () => button('Design review').click())
    expect(onOpenChat).toHaveBeenCalledWith('manager')
    await act(async () => button('Stop').click())
    expect(onStop).toHaveBeenCalled()

    // A finished worker has nothing to stop.
    await render('done')
    expect(container.querySelector('.worker-header-stop')).toBeNull()
  })

  it('says who started the chat, where it reports, and that typing reaches only it', async () => {
    await act(async () =>
      root.render(<WorkerBanner manager={manager} reportsToManager onOpenChat={vi.fn()} />)
    )
    expect(container.textContent).toBe(
      'Started by Design review. When this chat goes idle, its last message is sent there. What you type here goes to this chat only.'
    )
    await act(async () =>
      root.render(<WorkerBanner manager={manager} reportsToManager={false} onOpenChat={vi.fn()} />)
    )
    expect(container.textContent).toContain('This chat no longer reports there.')
  })

  it('shows the brief as a card from the manager that folds away', async () => {
    await act(async () =>
      root.render(
        <BriefCard
          brief={familyMessage('brief', 'manager', worker.conversationId, 'brief', 'Port it.')}
          managerTitle="Design review"
        />
      )
    )
    const toggle = container.querySelector('.family-brief-toggle') as HTMLButtonElement
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe(
      'Brief from Design review'
    )
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.family-brief-body')?.textContent).toBe('Port it.')
    await act(async () => toggle.click())
    expect(container.querySelector('.family-brief-body')).toBeNull()
  })

  it('quotes a message from the manager on one line that expands to the full text', async () => {
    const onOpenChat = vi.fn()
    await act(async () =>
      root.render(
        <SessionMessageRow
          message={familyMessage(
            'update',
            'manager',
            worker.conversationId,
            'update',
            'Keep the dialog separate.'
          )}
          sender={manager}
          onOpenChat={onOpenChat}
        />
      )
    )
    expect(container.querySelector('.family-message-summary')?.textContent).toBe(
      'Message from Design review: Keep the dialog separate.'
    )
    await act(async () => button('Message from').click())
    expect(container.querySelector('.family-message-body p')?.textContent).toBe(
      'Keep the dialog separate.'
    )
    await act(async () => button('Open Design review').click())
    expect(onOpenChat).toHaveBeenCalledWith('manager')
  })

  it('names the worker, its manager and its worktree on an approval in a worker chat', async () => {
    const interaction = {
      id: 'approval',
      kind: 'permission' as const,
      status: 'pending' as const,
      request: { title: 'Run a command?' }
    }
    await act(async () =>
      root.render(
        <WorkerChatContext.Provider
          value={{
            workerName: 'schedules',
            managerTitle: 'Design review',
            workplace: workerWorkplace(worker, worktree)
          }}
        >
          <AgentInteractionCard interaction={interaction} onResolve={vi.fn()} />
        </WorkerChatContext.Provider>
      )
    )
    expect(container.querySelector('.agent-interaction-context')?.textContent).toBe(
      'schedulesworker of Design reviewin worktree sidekick/schedules'
    )

    // Outside a worker chat the approval reads as before.
    await act(async () =>
      root.render(<AgentInteractionCard interaction={interaction} onResolve={vi.fn()} />)
    )
    expect(container.querySelector('.agent-interaction-context')).toBeNull()
  })

  it('describes a worker that shares the manager’s folder', () => {
    expect(workerWorkplace({ workIn: 'read-only' }, null)).toBe("the manager's folder, read-only")
    expect(workerWorkplace({ workIn: 'folder' }, null)).toBe("the manager's folder")
    expect(workerWorkplace({ workIn: null }, null)).toBeNull()
  })
})
