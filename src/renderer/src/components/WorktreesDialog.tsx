import { useEffect, useId, useState } from 'react'
import { ExternalLink, FolderOpen, GitBranch, Loader2, Trash2, X } from 'lucide-react'
import { useModalDialog } from '../hooks/useModalDialog'
import { worktreeBranchLabel, type ManagedWorktreeSummary } from '../../../shared/worktrees'
import './ForkConversationDialog.css'
import './Worktrees.css'

interface WorktreesDialogProps {
  isOpen: boolean
  worktrees: ManagedWorktreeSummary[]
  /** Scrolls to and highlights this worktree. */
  focusWorktreeId?: string | null
  onClose: () => void
  onRefresh: () => Promise<void>
  onOpenChat: (worktree: ManagedWorktreeSummary) => void
  /** Called after a removal so the sidebar drops the project and detached chats. */
  onRemoved: () => Promise<void>
}

function relativeTime(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

function stateOf(worktree: ManagedWorktreeSummary): { label: string; tone: string } | null {
  if (worktree.owners.some(({ running }) => running)) return { label: 'Working', tone: 'running' }
  if (worktree.setAsideAt) return { label: 'Set aside', tone: 'aside' }
  const changed = worktree.status?.changedFiles ?? 0
  if (changed) return { label: `${changed} changed`, tone: 'changed' }
  return null
}

/**
 * Lists the chats' worktrees: which chat, where it came from, and whether it is set aside.
 * SideKick keeps the most recently used on disk by itself, so the only action here is removal.
 */
export function WorktreesDialog({
  isOpen,
  worktrees,
  focusWorktreeId,
  onClose,
  onRefresh,
  onOpenChat,
  onRemoved
}: WorktreesDialogProps): React.JSX.Element | null {
  const dialogRef = useModalDialog<HTMLDivElement>(isOpen, onClose)
  const titleId = useId()
  const [working, setWorking] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!isOpen) return
    void onRefresh()
    // Refresh only when the dialog opens; removal refreshes on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || !focusWorktreeId) return
    document
      .getElementById(`worktree-row-${focusWorktreeId}`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusWorktreeId, isOpen, worktrees])

  if (!isOpen) return null

  const run = async (id: string, action: () => Promise<void>): Promise<void> => {
    if (working) return
    setWorking(id)
    setErrors(({ [id]: _cleared, ...rest }) => rest)
    try {
      await action()
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [id]: error instanceof Error ? error.message : String(error)
      }))
    } finally {
      setWorking(null)
    }
  }

  const remove = (worktree: ManagedWorktreeSummary): Promise<void> =>
    run(worktree.id, async () => {
      const result = await window.api.worktrees.remove(worktree.id)
      setConfirming(null)
      if (!result.removed) throw new Error(result.reason ?? 'The worktree was kept.')
      await onRemoved()
    })

  return (
    <div className="fork-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="fork-dialog worktrees-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="fork-dialog-header">
          <span className="fork-dialog-icon">
            <GitBranch size={18} />
          </span>
          <div>
            <h2 id={titleId}>Worktrees</h2>
            <p>
              Each chat can work in its own copy of the project. SideKick keeps the 15 most recently
              used; older ones are set aside and come back as they were when their chat continues.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {worktrees.length === 0 ? (
          <div className="worktrees-empty">
            <GitBranch size={20} aria-hidden="true" />
            <strong>No worktrees yet</strong>
            <span>Choose “New worktree” before the first message of a project chat.</span>
          </div>
        ) : (
          <ul className="worktrees-list">
            {worktrees.map((worktree) => {
              const state = stateOf(worktree)
              const running = state?.tone === 'running'
              const isWorking = working === worktree.id
              const chat = worktree.owners[0]?.title ?? 'No chat'
              const error = errors[worktree.id]
              return (
                <li
                  key={worktree.id}
                  id={`worktree-row-${worktree.id}`}
                  className={`worktrees-row${focusWorktreeId === worktree.id ? ' is-focused' : ''}${worktree.setAsideAt ? ' is-aside' : ''}`}
                >
                  <div className="worktrees-row-main">
                    <span className="worktrees-row-title" title={chat}>
                      {chat}
                    </span>
                    <span className="worktrees-row-meta" title={worktree.worktreeRoot}>
                      {worktree.sourceProjectName ?? 'Removed project'} ·{' '}
                      {worktreeBranchLabel(worktree)} · used {relativeTime(worktree.lastUsedAt)}
                    </span>
                  </div>
                  {state && (
                    <span className={`worktrees-pill is-${state.tone}`}>{state.label}</span>
                  )}
                  {confirming === worktree.id ? (
                    <div
                      className="worktrees-confirm"
                      role="alertdialog"
                      aria-label="Remove worktree"
                    >
                      <span>
                        Delete this folder
                        {worktree.status?.changedFiles ? ' and its uncommitted changes' : ''}?
                        Branches stay in the repository.
                      </span>
                      <button
                        type="button"
                        className="worktrees-action"
                        disabled={isWorking}
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="worktrees-action is-danger"
                        disabled={isWorking}
                        onClick={() => void remove(worktree)}
                      >
                        {isWorking ? (
                          <Loader2 size={13} className="icon-spin" />
                        ) : (
                          <Trash2 size={13} />
                        )}
                        Delete
                      </button>
                    </div>
                  ) : (
                    <div className="worktrees-actions">
                      <button
                        type="button"
                        className="worktrees-icon-action"
                        disabled={Boolean(working)}
                        onClick={() => onOpenChat(worktree)}
                        title="Open its chat"
                        aria-label="Open its chat"
                      >
                        <ExternalLink size={14} />
                      </button>
                      <button
                        type="button"
                        className="worktrees-icon-action"
                        disabled={Boolean(working) || Boolean(worktree.setAsideAt)}
                        onClick={() =>
                          void run(worktree.id, () => window.api.worktrees.reveal(worktree.id))
                        }
                        title={
                          worktree.setAsideAt
                            ? 'Set aside: the folder comes back when its chat continues'
                            : 'Show the folder'
                        }
                        aria-label="Show the folder"
                      >
                        <FolderOpen size={14} />
                      </button>
                      <button
                        type="button"
                        className="worktrees-icon-action is-danger"
                        disabled={Boolean(working) || running}
                        onClick={() => setConfirming(worktree.id)}
                        title={running ? 'Wait for the agent to finish' : 'Remove'}
                        aria-label="Remove"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                  {error && (
                    <div className="worktrees-notice is-error" role="alert">
                      {error}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
