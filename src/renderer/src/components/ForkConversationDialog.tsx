import { FolderGit2, FolderOpen, X } from 'lucide-react'
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
            <FolderOpen size={16} />
            <span>
              <strong>Current workspace</strong>
              <small>The same project folder, for an alternate conversation.</small>
            </span>
          </button>
          <button
            type="button"
            onClick={() => onChoose('worktree')}
            disabled={busy || !canUseWorktree}
          >
            <FolderGit2 size={16} />
            <span>
              <strong>New isolated worktree</strong>
              <small>
                {canUseWorktree
                  ? 'Its own branch and folder from the current commit. Uncommitted files stay here.'
                  : 'Attach this chat to a Git project to use an isolated worktree.'}
              </small>
            </span>
          </button>
        </div>
        {error && <div className="fork-dialog-error">{error}</div>}
      </div>
    </div>
  )
}
