// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedWorktreeSummary, WorktreeBranchOptions } from '../../../shared/worktrees'
import { WorktreesDialog } from './WorktreesDialog'
import { ProjectChoiceChip, WorkspaceBar } from './WorkspaceBar'
import { chooseSelectOption, selectOptions } from './Select.testing'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const changed: ManagedWorktreeSummary = {
  id: 'wt-1',
  folderPath: '/data/worktrees/p/cards-1',
  worktreeRoot: '/data/worktrees/p/cards-1',
  sourceProjectId: 'p',
  sourceProjectName: 'demo',
  branch: 'sidekick/cards',
  baseRef: 'main',
  createdAt: 1,
  lastUsedAt: 1,
  owners: [{ kind: 'chat', id: 'chat-1', title: 'Cards chat', running: false }],
  setAsideAt: null,
  status: { currentBranch: 'sidekick/cards', ahead: 2, changedFiles: 3 }
}

const api = {
  list: vi.fn(),
  branchOptions: vi.fn(
    async (): Promise<WorktreeBranchOptions> => ({
      branches: ['main', 'release'],
      currentBranch: 'main',
      isGitRepository: true
    })
  ),
  createForConversation: vi.fn(),
  remove: vi.fn(async (): Promise<{ removed: boolean; reason?: string }> => ({ removed: true })),
  reveal: vi.fn(async () => undefined)
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!match) throw new Error(`No button labelled ${label}`)
  return match
}

function labelled(container: HTMLElement, label: string): HTMLButtonElement {
  const match = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!match) throw new Error(`No button labelled ${label}`)
  return match
}

describe('worktree UI', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', { configurable: true, value: { worktrees: api } })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const renderDialog = async (
    worktrees: ManagedWorktreeSummary[] = [changed],
    onRemoved = vi.fn(async () => undefined)
  ) => {
    await act(async () => {
      root.render(
        <WorktreesDialog
          isOpen
          worktrees={worktrees}
          onClose={vi.fn()}
          onRefresh={vi.fn(async () => undefined)}
          onOpenChat={vi.fn()}
          onRemoved={onRemoved}
        />
      )
    })
    return onRemoved
  }

  it('marks a set-aside worktree and has no folder to show for it', async () => {
    await renderDialog([{ ...changed, setAsideAt: 5, status: null }])
    expect(labelled(container, 'Show the folder').disabled).toBe(true)
  })

  it('asks once before removing, then removes', async () => {
    const onRemoved = await renderDialog()
    await act(async () => labelled(container, 'Remove').click())
    expect(api.remove).not.toHaveBeenCalled()
    await act(async () => button(container, 'Delete').click())
    expect(api.remove).toHaveBeenCalledWith('wt-1')
    expect(onRemoved).toHaveBeenCalled()
  })

  it('does not report a worktree the main process kept as removed', async () => {
    api.remove.mockResolvedValueOnce({
      removed: false,
      reason: 'An agent is working in it. Stop it first.'
    })
    const onRemoved = await renderDialog()
    await act(async () => labelled(container, 'Remove').click())
    await act(async () => button(container, 'Delete').click())
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it('does not offer removal while an agent works in it', async () => {
    await renderDialog([
      { ...changed, owners: [{ kind: 'chat', id: 'chat-1', title: 'Cards chat', running: true }] }
    ])
    expect(labelled(container, 'Remove').disabled).toBe(true)
  })

  it('lets a new project chat choose a worktree and its base', async () => {
    const onWorkInChange = vi.fn()
    await act(async () => {
      root.render(
        <WorkspaceBar
          projectId="p"
          worktree={null}
          canChoose
          workIn="worktree"
          baseRef=""
          onWorkInChange={onWorkInChange}
          onBaseRefChange={vi.fn()}
          onManageWorktrees={vi.fn()}
        />
      )
    })
    expect(api.branchOptions).toHaveBeenCalledWith('p')
    const base = container.querySelector<HTMLElement>('.ui-select[aria-label="Start from"]')!
    expect((await selectOptions(base)).map((option) => option.label)).toEqual(['main', 'release'])
    await act(async () => button(container, 'This folder').click())
    expect(onWorkInChange).toHaveBeenCalledWith('folder')
  })

  it('lets a new chat outside any project pick one, so a worktree can be offered', async () => {
    const onChooseProject = vi.fn()
    await act(async () => {
      root.render(
        <ProjectChoiceChip
          projectChoices={[{ id: 'repo', name: 'Repo' }]}
          onChooseProject={onChooseProject}
        />
      )
    })
    const select = container.querySelector<HTMLElement>('.ui-select[aria-label="Project"]')!
    expect((await selectOptions(select)).map(({ label }) => label)).toEqual(['No project', 'Repo'])
    await chooseSelectOption(select, 'repo')
    expect(onChooseProject).toHaveBeenCalledWith('repo')
    expect(api.branchOptions).not.toHaveBeenCalled()
  })

  it('offers only the folder when the project is not a Git repository', async () => {
    api.branchOptions.mockResolvedValueOnce({
      branches: [],
      currentBranch: null,
      isGitRepository: false
    })
    await act(async () => {
      root.render(
        <WorkspaceBar
          projectId="plain"
          worktree={null}
          canChoose
          workIn="worktree"
          baseRef=""
          onWorkInChange={vi.fn()}
          onBaseRefChange={vi.fn()}
          onManageWorktrees={vi.fn()}
        />
      )
    })
    expect(container.querySelector('[role="radiogroup"]')).toBeNull()
  })
})
