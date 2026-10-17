import { useEffect, useId, useState } from 'react'
import { ArrowDown, ArrowUp, FolderOpen, GitBranch, Settings2 } from 'lucide-react'
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
  branchName: string
  baseRef: string
  disabled?: boolean
  error?: string | null
  onWorkInChange: (choice: WorkInChoice) => void
  onBranchNameChange: (name: string) => void
  onBaseRefChange: (ref: string) => void
  onManageWorktrees: () => void
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
  branchName,
  baseRef,
  disabled,
  error,
  onWorkInChange,
  onBranchNameChange,
  onBaseRefChange,
  onManageWorktrees
}: WorkspaceBarProps): React.JSX.Element | null {
  const [options, setOptions] = useState<WorktreeBranchOptions | null>(null)
  const branchId = useId()
  const baseId = useId()
  const choosing = canChoose && Boolean(projectId) && !worktree

  useEffect(() => {
    if (!choosing || !projectId) return
    let cancelled = false
    void window.api.worktrees
      .branchOptions(projectId)
      .then((result) => {
        if (!cancelled) setOptions(result)
      })
      .catch(() => {
        if (!cancelled) setOptions(null)
      })
    return () => {
      cancelled = true
    }
  }, [choosing, projectId])

  if (worktree) {
    const status = worktree.status
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
          {status && (status.ahead || status.behind) ? (
            <span
              className="workspace-bar-counts"
              title={`${status.ahead ?? 0} commits ahead of and ${status.behind ?? 0} behind ${worktree.baseRef ?? 'its base'}`}
            >
              <ArrowUp size={12} aria-hidden="true" />
              {status.ahead ?? 0}
              <ArrowDown size={12} aria-hidden="true" />
              {status.behind ?? 0}
            </span>
          ) : null}
          <button type="button" className="workspace-bar-link" onClick={onManageWorktrees}>
            Manage
          </button>
        </div>
      </div>
    )
  }

  if (!choosing) return null
  const gitAvailable = options?.isGitRepository !== false
  const effectiveChoice = gitAvailable ? workIn : 'folder'

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
            disabled={disabled || !gitAvailable}
            onClick={() => onWorkInChange('worktree')}
            title={
              gitAvailable
                ? 'A separate folder on its own branch, so other agents cannot overwrite this work'
                : 'Worktrees need a Git repository'
            }
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
            {/* Optional: without a name the worktree is a detached copy of the base, and the agent
                creates a branch when the work needs one. */}
            <label className="workspace-bar-field" htmlFor={branchId}>
              <GitBranch size={12} className="workspace-bar-muted" aria-hidden="true" />
              <input
                id={branchId}
                aria-label="New branch (optional)"
                value={branchName}
                placeholder="New branch (optional)"
                spellCheck={false}
                disabled={disabled}
                onChange={(event) => onBranchNameChange(event.target.value)}
                title="Leave empty to work on a copy of the base with no branch of its own. The agent can create a branch when the work needs one."
              />
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
