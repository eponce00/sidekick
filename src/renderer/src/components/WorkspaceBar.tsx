import { useEffect, useId, useState } from 'react'
import { FolderGit2, FolderOpen, Settings2 } from 'lucide-react'
import {
  worktreeBranchLabel,
  type ManagedWorktreeSummary,
  type WorkInChoice,
  type WorktreeBranchOptions
} from '../../../shared/worktrees'
import './Worktrees.css'
import { Select } from './Select'

interface WorkspaceBarProps {
  projectId: string | null
  /** The chat's project is one of SideKick's worktrees. */
  worktree: ManagedWorktreeSummary | null
  /** The chat has not sent a message yet, so it can still choose where to work. */
  canChoose: boolean
  workIn: WorkInChoice
  baseRef: string
  disabled?: boolean
  error?: string | null
  onWorkInChange: (choice: WorkInChoice) => void
  onBaseRefChange: (ref: string) => void
  onManageWorktrees: () => void
  /** Reports whether the project can have worktrees, once that is known. */
  onWorktreesAvailableChange?: (available: boolean) => void
}

/**
 * Before the first message of a chat outside any project, a chip in the composer's context
 * controls that moves it into a project, so a folder or a worktree can be offered. It is part of
 * the composer rather than a card above it, which kept the welcome screen to one surface.
 */
export function ProjectChoiceChip({
  projectChoices,
  onChooseProject
}: {
  projectChoices: ReadonlyArray<{ id: string; name: string }>
  onChooseProject: (projectId: string) => void
}): React.JSX.Element {
  const id = useId()
  return (
    <label
      className="composer-project-chip"
      htmlFor={id}
      title="Choose a project to work in its folder or a new worktree"
      onClick={(event) => event.stopPropagation()}
    >
      <FolderOpen size={13} aria-hidden="true" />
      <Select
        id={id}
        value=""
        onChange={(event) => {
          if (event.target.value) onChooseProject(event.target.value)
        }}
        aria-label="Project"
      >
        <option value="">No project</option>
        {projectChoices.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </Select>
    </label>
  )
}

/**
 * Before the first message of a project chat, the choice between the project folder and a new
 * worktree. Once the chat works in a worktree, `WorktreeChip` in the composer says so instead.
 */
export function WorkspaceBar({
  projectId,
  worktree,
  canChoose,
  workIn,
  baseRef,
  disabled,
  error,
  onWorkInChange,
  onBaseRefChange,
  onManageWorktrees,
  onWorktreesAvailableChange
}: WorkspaceBarProps): React.JSX.Element | null {
  const [options, setOptions] = useState<WorktreeBranchOptions | null>(null)
  const baseId = useId()
  const choosing = canChoose && Boolean(projectId) && !worktree

  useEffect(() => {
    if (!choosing || !projectId) return
    let cancelled = false
    void window.api.worktrees
      .branchOptions(projectId)
      .then((result) => {
        if (cancelled) return
        setOptions(result)
        onWorktreesAvailableChange?.(result.isGitRepository)
      })
      .catch(() => {
        if (!cancelled) setOptions(null)
      })
    return () => {
      cancelled = true
    }
  }, [choosing, projectId, onWorktreesAvailableChange])

  // A chat outside any project picks one with `ProjectChoiceChip` in the composer; only a
  // failure to move it there is said here.
  if (canChoose && !projectId) {
    return error ? (
      <div className="workspace-bar-area">
        <div className="workspace-bar-error" role="alert">
          {error}
        </div>
      </div>
    ) : null
  }
  if (!choosing) return null
  // A folder without Git has no worktrees to offer; say so instead of showing a dead button.
  if (options?.isGitRepository === false) {
    return (
      <div className="workspace-bar-area">
        <div className="workspace-bar" role="status" aria-label="Where this chat works">
          <FolderOpen size={14} className="workspace-bar-icon" aria-hidden="true" />
          <span>This folder</span>
          <span className="workspace-bar-muted">
            Not a Git repository, so new worktrees are not available
          </span>
        </div>
      </div>
    )
  }
  const effectiveChoice = workIn

  return (
    <div className="workspace-bar-area">
      <div className="workspace-bar is-choosing">
        <span className="workspace-bar-label">Work in</span>
        <div className="workspace-bar-segments" role="radiogroup" aria-label="Work in">
          <button
            type="button"
            role="radio"
            aria-checked={effectiveChoice === 'folder'}
            className={effectiveChoice === 'folder' ? 'is-selected' : ''}
            disabled={disabled}
            onClick={() => onWorkInChange('folder')}
            title="Work directly in the project folder"
          >
            <FolderOpen size={13} aria-hidden="true" />
            This folder
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={effectiveChoice === 'worktree'}
            className={effectiveChoice === 'worktree' ? 'is-selected' : ''}
            disabled={disabled}
            onClick={() => onWorkInChange('worktree')}
            title="A separate copy of the project, so chats working at once do not overwrite each other"
          >
            <FolderGit2 size={13} aria-hidden="true" />
            New worktree
          </button>
        </div>
        {effectiveChoice === 'worktree' && (
          <>
            <label className="workspace-bar-field is-base" htmlFor={baseId}>
              <span className="workspace-bar-muted">from</span>
              <Select
                id={baseId}
                value={baseRef}
                disabled={disabled || !options?.branches.length}
                onChange={(event) => onBaseRefChange(event.target.value)}
                aria-label="Start from"
              >
                <option value="">{options?.currentBranch ?? 'current commit'}</option>
                {options?.branches
                  .filter((branch) => branch !== options.currentBranch)
                  .map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
              </Select>
            </label>
          </>
        )}
        <button
          type="button"
          className="workspace-bar-icon-button"
          onClick={onManageWorktrees}
          title="Manage worktrees"
          aria-label="Manage worktrees"
        >
          <Settings2 size={14} />
        </button>
      </div>
      {error && (
        <div className="workspace-bar-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

/**
 * A quiet mark in the composer for a chat that works in its own worktree: its branch, or the base
 * it is a copy of. It opens the worktree list.
 */
export function WorktreeChip({
  worktree,
  onManage
}: {
  worktree: ManagedWorktreeSummary
  onManage: () => void
}): React.JSX.Element {
  const label = worktreeBranchLabel(worktree)
  const state = worktree.setAsideAt ? ' It is set aside and comes back when you send.' : ''
  return (
    <button
      type="button"
      className="composer-worktree-chip"
      onClick={onManage}
      title={`Works in its own worktree, ${label}.${state} ${worktree.folderPath}`}
      aria-label={`Worktree: ${label}. Manage worktrees`}
    >
      <FolderGit2 size={13} aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}
