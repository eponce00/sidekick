import { useId } from 'react'
import { FolderGit2, FolderOpen, X } from 'lucide-react'
import { useModalDialog } from '../hooks/useModalDialog'
import type { WorkspaceOccupant } from '../../../shared/worktrees'
import './ForkConversationDialog.css'
import './Worktrees.css'

export type WorkspaceBusyChoice = 'worktree' | 'share' | 'cancel'

interface WorkspaceBusyDialogProps {
  isOpen: boolean
  occupants: WorkspaceOccupant[]
  /** A chat with messages forks into the worktree; a new one moves there. */
  hasHistory: boolean
  canUseWorktree: boolean
  busy: boolean
  error?: string | null
  onChoose: (choice: WorkspaceBusyChoice) => void
}

/** Asked before a run starts in a folder where another agent is already writing. */
export function WorkspaceBusyDialog({
  isOpen,
  occupants,
  hasHistory,
  canUseWorktree,
  busy,
  error,
  onChoose
}: WorkspaceBusyDialogProps): React.JSX.Element | null {
  const cancel = (): void => {
    if (!busy) onChoose('cancel')
  }
  const dialogRef = useModalDialog<HTMLDivElement>(isOpen, cancel)
  const titleId = useId()
  if (!isOpen) return null
  const names = occupants.map(({ title }) => title)

  return (
    <div className="fork-dialog-backdrop" role="presentation" onClick={cancel}>
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
            <h2 id={titleId}>Another agent is working in this folder</h2>
            <p>
              {names.length === 1 ? (
                <>
                  <strong className="workspace-busy-name">{names[0]}</strong> is changing files
                  here.
                </>
              ) : (
                `${names.length} chats are changing files here.`
              )}{' '}
              Two agents in one folder can overwrite each other&apos;s work.
            </p>
          </div>
          <button type="button" onClick={cancel} disabled={busy} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="fork-dialog-options">
          <button
            type="button"
            onClick={() => onChoose('worktree')}
            disabled={busy || !canUseWorktree}
            autoFocus
          >
            <FolderGit2 size={16} />
            <span>
              <strong>{hasHistory ? 'Fork into a new worktree' : 'Start in a new worktree'}</strong>
              <small>
                {!canUseWorktree
                  ? 'Worktrees need a project in a Git repository.'
                  : hasHistory
                    ? 'A copy of this chat continues on its own branch and folder, with your message ready to send.'
                    : 'This chat gets its own branch and folder, so neither agent touches the other’s files.'}
              </small>
            </span>
          </button>
          <button type="button" onClick={() => onChoose('share')} disabled={busy}>
            <FolderOpen size={16} />
            <span>
              <strong>Work here anyway</strong>
              <small>
                Both agents write in the same folder. Only for changes that cannot overlap.
              </small>
            </span>
          </button>
        </div>
        {error && <div className="fork-dialog-error">{error}</div>}
      </div>
    </div>
  )
}
