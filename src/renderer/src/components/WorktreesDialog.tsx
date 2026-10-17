import { useEffect, useId, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  FolderOpen,
  GitBranch,
  GitMerge,
  HardDrive,
  Loader2,
  MessageSquare,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react'
import { useModalDialog } from '../hooks/useModalDialog'
import {
  worktreeBranchLabel,
  type ManagedWorktreeDiskUsage,
  type ManagedWorktreeSummary,
  type WorktreeRemovalBlocker
} from '../../../shared/worktrees'
import './ForkConversationDialog.css'
import './Worktrees.css'

interface WorktreesDialogProps {
  isOpen: boolean
  worktrees: ManagedWorktreeSummary[]
  /** Scrolls to and highlights this worktree's project. */
  focusProjectId?: string | null
  onClose: () => void
  onRefresh: () => Promise<void>
  onOpenProject: (projectId: string) => void
  /** Called after a removal so the sidebar drops the project and detached chats. */
  onRemoved: () => Promise<void>
}

interface RowNotice {
  tone: 'info' | 'success' | 'error'
  text: string
  details?: string[]
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function relativeTime(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/** Lists SideKick's worktrees with their Git state, the chats using them, and safe actions. */
export function WorktreesDialog({
  isOpen,
  worktrees,
  focusProjectId,
  onClose,
  onRefresh,
  onOpenProject,
  onRemoved
}: WorktreesDialogProps): React.JSX.Element | null {
  const dialogRef = useModalDialog<HTMLDivElement>(isOpen, onClose)
  const titleId = useId()
  const [disk, setDisk] = useState<Record<string, ManagedWorktreeDiskUsage>>({})
  const [working, setWorking] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [notices, setNotices] = useState<Record<string, RowNotice>>({})
  const [confirming, setConfirming] = useState<{ id: string; deleteBranch: boolean } | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setRefreshing(true)
    void onRefresh().finally(() => setRefreshing(false))
    // Refresh only when the dialog opens; actions refresh on their own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    for (const worktree of worktrees) {
      if (disk[worktree.id]) continue
      void window.api.worktrees
        .diskUsage(worktree.id)
        .then((usage) => {
          if (!cancelled) setDisk((current) => ({ ...current, [usage.id]: usage }))
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [disk, isOpen, worktrees])

  useEffect(() => {
    if (!isOpen || !focusProjectId) return
    const target = worktrees.find(({ projectId }) => projectId === focusProjectId)
    if (!target) return
    document
      .getElementById(`worktree-row-${target.id}`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusProjectId, isOpen, worktrees])

  if (!isOpen) return null

  const notify = (id: string, notice: RowNotice | null): void =>
    setNotices((current) => {
      const next = { ...current }
      if (notice) next[id] = notice
      else delete next[id]
      return next
    })

  const run = async (id: string, action: () => Promise<void>): Promise<void> => {
    if (working) return
    setWorking(id)
    try {
      await action()
    } catch (error) {
      notify(id, { tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setWorking(null)
    }
  }

  const sync = (worktree: ManagedWorktreeSummary): Promise<void> =>
    run(worktree.id, async () => {
      const result = await window.api.worktrees.sync(worktree.id)
      notify(worktree.id, {
        tone:
          result.status === 'merged' || result.status === 'up-to-date'
            ? 'success'
            : result.status === 'conflict'
              ? 'error'
              : 'info',
        text: result.message,
        details: result.status === 'conflict' ? result.conflicts : undefined
      })
      await onRefresh()
    })

  const remove = (worktree: ManagedWorktreeSummary, force: boolean, deleteBranch = false) =>
    run(worktree.id, async () => {
      const result = await window.api.worktrees.remove({ id: worktree.id, force, deleteBranch })
      setConfirming(null)
      if (!result.removed) {
        notify(worktree.id, {
          tone: 'error',
          text: 'Kept. ' + result.blockers.map(({ message }) => message).join(' ')
        })
        await onRefresh()
        return
      }
      notify(worktree.id, null)
      await onRemoved()
    })

  const reveal = (worktree: ManagedWorktreeSummary): Promise<void> =>
    run(worktree.id, () => window.api.worktrees.reveal(worktree.id))

  const startRemoval = (worktree: ManagedWorktreeSummary): void => {
    if (!worktree.blockers.length) {
      void remove(worktree, false)
      return
    }
    setConfirming({ id: worktree.id, deleteBranch: false })
  }

  const hardBlockers = (blockers: WorktreeRemovalBlocker[]) =>
    blockers.filter(({ forceable }) => !forceable)

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
              Separate folders on their own branches, so agents working in parallel never overwrite
              each other. They live in SideKick&apos;s data folder, not in your project.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="worktrees-toolbar">
          <span className="workspace-bar-muted">
            {worktrees.length === 1 ? '1 worktree' : `${worktrees.length} worktrees`}
          </span>
          <button
            type="button"
            className="worktrees-action"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true)
              setDisk({})
              void onRefresh().finally(() => setRefreshing(false))
            }}
          >
            <RefreshCw size={13} className={refreshing ? 'icon-spin' : undefined} />
            Refresh
          </button>
        </div>

        {worktrees.length === 0 ? (
          <div className="worktrees-empty">
            <GitBranch size={20} aria-hidden="true" />
            <strong>No worktrees yet</strong>
            <span>
              Choose “New worktree” before the first message of a project chat, or fork a chat into
              a new worktree.
            </span>
          </div>
        ) : (
          <ul className="worktrees-list">
            {worktrees.map((worktree) => {
              const status = worktree.status
              const usage = disk[worktree.id]
              const notice = notices[worktree.id]
              const isWorking = working === worktree.id
              const isConfirming = confirming?.id === worktree.id
              const hard = hardBlockers(worktree.blockers)
              const unmerged = worktree.blockers.some(({ code }) => code === 'unmerged')
              const running = worktree.owners.some((owner) => owner.running)
              return (
                <li
                  key={worktree.id}
                  id={`worktree-row-${worktree.id}`}
                  className={`worktrees-row${focusProjectId === worktree.projectId ? ' is-focused' : ''}`}
                >
                  <div className="worktrees-row-head">
                    <GitBranch size={15} className="workspace-bar-icon" aria-hidden="true" />
                    <span className="workspace-bar-branch" title={worktree.worktreeRoot}>
                      {worktreeBranchLabel(worktree)}
                    </span>
                    <span className="workspace-bar-muted">
                      {worktree.sourceProjectName ?? 'Removed project'}
                      {worktree.baseRef ? ` · from ${worktree.baseRef}` : ''}
                    </span>
                    {running && <span className="worktrees-pill is-running">Agent working</span>}
                  </div>

                  <div className="worktrees-facts">
                    {status ? (
                      <>
                        <span title="Commits in this worktree that its base does not have">
                          <ArrowUp size={12} aria-hidden="true" />
                          {status.ahead ?? '?'} ahead
                        </span>
                        <span title="Commits on the base that this worktree does not have">
                          <ArrowDown size={12} aria-hidden="true" />
                          {status.behind ?? '?'} behind
                        </span>
                        <span className={status.changedFiles ? 'is-attention' : undefined}>
                          {status.changedFiles
                            ? `${status.changedFiles} uncommitted`
                            : 'No uncommitted changes'}
                        </span>
                        <span>{status.merged ? 'Merged' : 'Not merged'}</span>
                      </>
                    ) : (
                      <span className="is-attention">Git state unavailable</span>
                    )}
                    <span title="Disk use, without following links">
                      <HardDrive size={12} aria-hidden="true" />
                      {usage
                        ? `${usage.truncated ? 'over ' : ''}${formatBytes(usage.bytes)}`
                        : 'Measuring…'}
                    </span>
                    <span title={new Date(worktree.lastUsedAt).toLocaleString()}>
                      Used {relativeTime(worktree.lastUsedAt)}
                    </span>
                  </div>

                  <div className="worktrees-owners">
                    <MessageSquare size={12} aria-hidden="true" />
                    <span>
                      {worktree.owners.length
                        ? worktree.owners
                            .map((owner) => `${owner.title}${owner.running ? ' (working)' : ''}`)
                            .join(', ')
                        : 'No chats use it'}
                    </span>
                  </div>

                  {notice && (
                    <div className={`worktrees-notice is-${notice.tone}`} role="status">
                      {notice.text}
                      {notice.details?.length ? (
                        <ul>
                          {notice.details.map((detail) => (
                            <li key={detail}>{detail}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  )}

                  {isConfirming ? (
                    <div
                      className="worktrees-confirm"
                      role="alertdialog"
                      aria-label="Remove anyway"
                    >
                      <strong>Remove this worktree anyway?</strong>
                      <ul>
                        {worktree.blockers.map((blocker) => (
                          <li key={blocker.code}>{blocker.message}</li>
                        ))}
                      </ul>
                      {unmerged && worktree.branch && (
                        <label className="worktrees-checkbox">
                          <input
                            type="checkbox"
                            checked={confirming.deleteBranch}
                            onChange={(event) =>
                              setConfirming({ id: worktree.id, deleteBranch: event.target.checked })
                            }
                          />
                          Also delete {worktree.branch} and its unmerged commits
                        </label>
                      )}
                      <div className="worktrees-actions">
                        <button
                          type="button"
                          className="worktrees-action"
                          onClick={() => setConfirming(null)}
                          disabled={isWorking}
                        >
                          Keep it
                        </button>
                        <button
                          type="button"
                          className="worktrees-action is-danger"
                          disabled={isWorking || hard.length > 0}
                          onClick={() => void remove(worktree, true, confirming.deleteBranch)}
                        >
                          {isWorking ? (
                            <Loader2 size={13} className="icon-spin" />
                          ) : (
                            <Trash2 size={13} />
                          )}
                          Remove anyway
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {hard.length > 0 && (
                        <div className="worktrees-notice is-info">
                          {hard.map(({ message }) => message).join(' ')}
                        </div>
                      )}
                      <div className="worktrees-actions">
                        <button
                          type="button"
                          className="worktrees-action"
                          disabled={Boolean(working)}
                          onClick={() => onOpenProject(worktree.projectId)}
                        >
                          <ExternalLink size={13} />
                          Open
                        </button>
                        <button
                          type="button"
                          className="worktrees-action"
                          disabled={Boolean(working) || !status}
                          onClick={() => void reveal(worktree)}
                        >
                          <FolderOpen size={13} />
                          Show folder
                        </button>
                        <button
                          type="button"
                          className="worktrees-action"
                          disabled={Boolean(working) || !status || running}
                          title={
                            running
                              ? 'Wait for the agent to finish'
                              : `Merge ${worktree.baseRef ?? 'the base'} into ${worktree.branch ?? 'this worktree'}`
                          }
                          onClick={() => void sync(worktree)}
                        >
                          {isWorking ? (
                            <Loader2 size={13} className="icon-spin" />
                          ) : (
                            <GitMerge size={13} />
                          )}
                          Sync with base
                        </button>
                        <button
                          type="button"
                          className="worktrees-action is-danger"
                          disabled={Boolean(working) || hard.length > 0}
                          title={
                            hard.length
                              ? hard.map(({ message }) => message).join(' ')
                              : worktree.blockers.length
                                ? 'Shows what would be lost before removing'
                                : 'Nothing would be lost'
                          }
                          onClick={() => startRemoval(worktree)}
                        >
                          <Trash2 size={13} />
                          Remove
                        </button>
                      </div>
                    </>
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
