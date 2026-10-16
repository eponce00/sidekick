// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedWorktreeSummary, WorktreeBranchOptions } from '../../../shared/worktrees'
import { WorktreesDialog } from './WorktreesDialog'
import { WorkspaceBar } from './WorkspaceBar'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const changed: ManagedWorktreeSummary = {
  id: 'wt-1',
  projectId: 'project-wt-1',
  projectName: 'demo · sidekick/cards',
  folderPath: '/data/worktrees/p/cards-1',
  worktreeRoot: '/data/worktrees/p/cards-1',
  sourceProjectId: 'p',
  sourceProjectName: 'demo',
  branch: 'sidekick/cards',
  baseRef: 'main',
  createdAt: 1,
  lastUsedAt: 1,
  owners: [{ kind: 'chat', id: 'chat-1', title: 'Cards chat', running: false }],
  status: { currentBranch: 'sidekick/cards', ahead: 2, behind: 1, changedFiles: 3, merged: false },
  blockers: [
    { code: 'in-use', message: 'A chat uses it.', forceable: true },
    { code: 'modified', message: '3 uncommitted changes would be lost.', forceable: true },
    { code: 'unmerged', message: 'sidekick/cards has 2 commits main does not.', forceable: true }
  ]
}

const api = {
  list: vi.fn(),
  diskUsage: vi.fn(async (id: string) => ({ id, bytes: 2048, truncated: false })),
  branchOptions: vi.fn(
    async (): Promise<WorktreeBranchOptions> => ({
      branches: ['main', 'release'],
      currentBranch: 'main',
      isGitRepository: true,
      isManagedWorktree: false
    })
  ),
  createForConversation: vi.fn(),
  remove: vi.fn(async () => ({ removed: true, blockers: [] })),
  sync: vi.fn(async () => ({
    status: 'conflict' as const,
    message: 'Merging main conflicts in 1 file. Nothing was changed.',
    conflicts: ['README.md']
  })),
  reveal: vi.fn(async () => undefined)
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
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

  const renderDialog = async (onRemoved = vi.fn(async () => undefined)) => {
    await act(async () => {
      root.render(
        <WorktreesDialog
          isOpen
          worktrees={[changed]}
          onClose={vi.fn()}
          onRefresh={vi.fn(async () => undefined)}
          onOpenProject={vi.fn()}
          onRemoved={onRemoved}
        />
      )
    })
    return onRemoved
  }

  it('shows Git state, owners and disk use', async () => {
    await renderDialog()
    const text = container.textContent ?? ''
    expect(text).toContain('sidekick/cards')
    expect(text).toContain('2 ahead')
    expect(text).toContain('1 behind')
    expect(text).toContain('3 uncommitted')
    expect(text).toContain('Cards chat')
    expect(text).toContain('2.0 KB')
  })

  it('asks before a forced removal and only deletes the branch when checked', async () => {
    const onRemoved = await renderDialog()
    await act(async () => button(container, 'Remove').click())
    expect(api.remove).not.toHaveBeenCalled()
    expect(container.textContent).toContain('3 uncommitted changes would be lost.')

    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => checkbox.click())
    await act(async () => button(container, 'Remove anyway').click())
    expect(api.remove).toHaveBeenCalledWith({ id: 'wt-1', force: true, deleteBranch: true })
    expect(onRemoved).toHaveBeenCalled()
  })

  it('removes a worktree with nothing to lose without asking', async () => {
    await act(async () => {
      root.render(
        <WorktreesDialog
          isOpen
          worktrees={[{ ...changed, owners: [], blockers: [] }]}
          onClose={vi.fn()}
          onRefresh={vi.fn(async () => undefined)}
          onOpenProject={vi.fn()}
          onRemoved={vi.fn(async () => undefined)}
        />
      )
    })
    await act(async () => button(container, 'Remove').click())
    expect(api.remove).toHaveBeenCalledWith({ id: 'wt-1', force: false, deleteBranch: false })
  })

  it('reports a conflicting sync with the files involved', async () => {
    await renderDialog()
    await act(async () => button(container, 'Sync with base').click())
    expect(api.sync).toHaveBeenCalledWith('wt-1')
    expect(container.textContent).toContain('conflicts in 1 file')
    expect(container.textContent).toContain('README.md')
  })

  it('names the worktree a chat works in', async () => {
    await act(async () => {
      root.render(
        <WorkspaceBar
          projectId="project-wt-1"
          worktree={changed}
          canChoose={false}
          workIn="folder"
          branchName=""
          branchPlaceholder=""
          baseRef=""
          onWorkInChange={vi.fn()}
          onBranchNameChange={vi.fn()}
          onBaseRefChange={vi.fn()}
          onManageWorktrees={vi.fn()}
        />
      )
    })
    expect(container.textContent).toContain('sidekick/cards')
    expect(container.textContent).toContain('worktree from main')
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
          branchName=""
          branchPlaceholder="sidekick/fix-it"
          baseRef=""
          onWorkInChange={onWorkInChange}
          onBranchNameChange={vi.fn()}
          onBaseRefChange={vi.fn()}
          onManageWorktrees={vi.fn()}
        />
      )
    })
    expect(api.branchOptions).toHaveBeenCalledWith('p')
    expect(container.querySelector('input')?.placeholder).toBe('sidekick/fix-it')
    const options = [...container.querySelectorAll('option')].map((option) => option.textContent)
    expect(options).toEqual(['main', 'release'])
    await act(async () => button(container, 'This folder').click())
    expect(onWorkInChange).toHaveBeenCalledWith('folder')
  })

  it('offers only the folder when the project is not a Git repository', async () => {
    api.branchOptions.mockResolvedValueOnce({
      branches: [],
      currentBranch: null,
      isGitRepository: false,
      isManagedWorktree: false
    })
    await act(async () => {
      root.render(
        <WorkspaceBar
          projectId="plain"
          worktree={null}
          canChoose
          workIn="worktree"
          branchName=""
          branchPlaceholder=""
          baseRef=""
          onWorkInChange={vi.fn()}
          onBranchNameChange={vi.fn()}
          onBaseRefChange={vi.fn()}
          onManageWorktrees={vi.fn()}
        />
      )
    })
    expect(button(container, 'New worktree').disabled).toBe(true)
    expect(container.querySelector('input')).toBeNull()
  })
})
