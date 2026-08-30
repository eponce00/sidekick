import { GitBranch, FolderOpen, X } from 'lucide-react'
import { useId } from 'react'
import { useModalDialog } from '../hooks/useModalDialog'
import './ForkConversationDialog.css'

interface ForkConversationDialogProps {
  isOpen: boolean
  canUseWorktree: boolean
  busy: boolean
  error?: string | null
  onChoose: (mode: 'current' | 'worktree') => void
  onCancel: () => void
}

export function ForkConversationDialog({
  isOpen,
  canUseWorktree,
  busy,
  error,
  onChoose,
  onCancel
}: ForkConversationDialogProps): React.JSX.Element | null {
  const dialogRef = useModalDialog<HTMLDivElement>(isOpen, onCancel)
  const titleId = useId()
  if (!isOpen) return null

  return (
    <div className="fork-dialog-backdrop" role="presentation" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="fork-dialog"
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
            <h2 id={titleId}>Fork from this message</h2>
            <p>The new chat keeps the conversation through this point.</p>
          </div>
          <button type="button" onClick={onCancel} disabled={busy} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="fork-dialog-options">
          <button type="button" onClick={() => onChoose('current')} disabled={busy}>
            <FolderOpen size={18} />
            <span>
              <strong>Current workspace</strong>
              <small>
                Continue in the same project folder. Best for an alternate conversation.
              </small>
            </span>
          </button>
          <button
            type="button"
            onClick={() => onChoose('worktree')}
            disabled={busy || !canUseWorktree}
          >
            <FolderOpen size={18} />
            <span>
              <strong>New isolated worktree</strong>
              <small>
                {canUseWorktree
                  ? 'Create a separate Git branch and folder from the current commit.'
                  : 'Attach this chat to a Git project to use an isolated worktree.'}
              </small>
            </span>
          </button>
        </div>

        <p className="fork-dialog-note">
          Uncommitted files remain only in the current workspace and are not copied into a new
          worktree.
        </p>
        {error && <div className="fork-dialog-error">{error}</div>}
      </div>
    </div>
  )
}
