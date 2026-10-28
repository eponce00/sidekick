// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedWorktreeSummary } from '../../../shared/worktrees'
import AgentInteractionCard from './AgentInteractionCard'
import { WorkerChatContext } from './sessionChatContext'
import { workerWorkplace } from '../utils/sessionLabels'
import { WorkerChatHeader } from './WorkerChatParts'
import { familyMember } from './sessionTestFixtures'

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

  it('leads back to the manager, and stops only a worker still running', async () => {
    const onOpenChat = vi.fn()
    const onStop = vi.fn()
    const render = async (state: 'waiting' | 'done', reportsToManager = true): Promise<void> =>
      act(async () =>
        root.render(
          <WorkerChatHeader
            worker={worker}
            manager={manager}
            state={state}
            reason={state === 'waiting' ? 'Approval: run npm test' : undefined}
            worktree={worktree}
            reportsToManager={reportsToManager}
            onOpenChat={onOpenChat}
            onStop={onStop}
          />
        )
      )
    await render('waiting')
    await act(async () => button('Design review').click())
    expect(onOpenChat).toHaveBeenCalledWith('manager')
    await act(async () => button('Stop').click())
    expect(onStop).toHaveBeenCalled()

    // A finished worker has nothing to stop.
    await render('done', false)
    expect(container.querySelector('.worker-header-stop')).toBeNull()
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
})
