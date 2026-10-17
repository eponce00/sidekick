import { useEffect, useId, useState } from 'react'
import { FolderOpen, GitBranch, Settings2 } from 'lucide-react'
import {
  worktreeBranchLabel,
  type ManagedWorktreeSummary,
  type WorkInChoice,
  type WorktreeBranchOptions
} from '../../../shared/worktrees'
import './Worktrees.css'

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
  /** Projects a chat outside any project can move into before its first message. */
  projectChoices?: ReadonlyArray<{ id: string; name: string }>
  onChooseProject?: (projectId: string) => void
}

/**
 * Says where a chat works: its worktree and branch, or, before the first message of a project
 * chat, a choice between the project folder and a new worktree.
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
  onWorktreesAvailableChange,
  projectChoices = [],
  onChooseProject
}: WorkspaceBarProps): React.JSX.Element | null {
  const [options, setOptions] = useState<WorktreeBranchOptions | null>(null)
  const baseId = useId()
  const projectSelectId = useId()
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

  if (worktree) {
    return (
      <div className="workspace-bar-area">
        <div className="workspace-bar" role="status" aria-label="Where this chat works">
          <GitBranch size={14} className="workspace-bar-icon" aria-hidden="true" />
          <span className="workspace-bar-branch" title={worktree.worktreeRoot}>
            {worktreeBranchLabel(worktree)}
          </span>
          <span className="workspace-bar-muted">
            {/* A detached worktree's label already names its base. */}
            {(worktree.status?.currentBranch ?? worktree.branch) && worktree.baseRef
              ? `worktree from ${worktree.baseRef}`
              : 'worktree'}
          </span>
          {worktree.setAsideAt ? (
            <span
              className="workspace-bar-muted"
              title="SideKick set this worktree aside to keep the number on disk down. It comes back as it was when you send a message."
            >
              · set aside until you send
            </span>
          ) : null}
          <button type="button" className="workspace-bar-link" onClick={onManageWorktrees}>
            Manage
          </button>
        </div>
      </div>
    )
  }

  // A chat outside any project has no folder to copy, so it picks a project first.
  if (canChoose && !projectId && onChooseProject && projectChoices.length) {
    return (
      <div className="workspace-bar-area">
        <div className="workspace-bar is-choosing">
          <span className="workspace-bar-label">Work in</span>
          <label className="workspace-bar-field is-base" htmlFor={projectSelectId}>
            <FolderOpen size={12} className="workspace-bar-muted" aria-hidden="true" />
            <select
              id={projectSelectId}
              value=""
              disabled={disabled}
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
            </select>
          </label>
          <span className="workspace-bar-muted">
            Choose a project to work in its folder or a new worktree
          </span>
        </div>
        {error && (
          <div className="workspace-bar-error" role="alert">
            {error}
          </div>
        )}
      </div>
    )
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
            <GitBranch size={13} aria-hidden="true" />
            New worktree
          </button>
        </div>
        {effectiveChoice === 'worktree' && (
          <>
            <label className="workspace-bar-field is-base" htmlFor={baseId}>
              <span className="workspace-bar-muted">from</span>
              <select
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
              </select>
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
