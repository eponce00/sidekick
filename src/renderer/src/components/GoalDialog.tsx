import { useState } from 'react'
import { Target, X } from 'lucide-react'
import { CONVERSATION_GOAL_MAX_LENGTH } from '../../../shared/conversationGoals'
import { useModalDialog } from '../hooks/useModalDialog'

interface GoalDialogProps {
  isOpen: boolean
  initialObjective?: string
  mode: 'create' | 'edit'
  onClose: () => void
  onSubmit: (objective: string) => Promise<void> | void
}

export function GoalDialog({
  isOpen,
  initialObjective = '',
  mode,
  onClose,
  onSubmit
}: GoalDialogProps): React.JSX.Element | null {
  const [objective, setObjective] = useState(initialObjective)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useModalDialog<HTMLElement>(isOpen, onClose)
  const submitShortcut = window.api.app.platform === 'macos' ? '⌘ Enter' : 'Ctrl Enter'

  if (!isOpen) return null

  const submit = async (): Promise<void> => {
    if (!objective.trim() || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const submitted = onSubmit(objective.trim())
      if (mode === 'create') onClose()
      await submitted
      if (mode === 'edit') onClose()
    } catch (caught) {
      if (mode === 'create') return
      setError(caught instanceof Error ? caught.message : 'Could not save the goal')
      setSubmitting(false)
    }
  }

  return (
    <div className="goal-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="goal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="goal-dialog-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="goal-dialog-header">
          <span className="goal-dialog-icon" aria-hidden="true">
            <Target size={17} />
          </span>
          <div>
            <h2 id="goal-dialog-title">{mode === 'create' ? 'Start a goal' : 'Edit goal'}</h2>
            <p>SideKick will keep working across model turns until the outcome is verified.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close goal dialog">
            <X size={16} />
          </button>
        </header>
        <label className="goal-dialog-field">
          <span>Objective and definition of done</span>
          <textarea
            autoFocus
            value={objective}
            maxLength={CONVERSATION_GOAL_MAX_LENGTH}
            onChange={(event) => setObjective(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit()
            }}
            placeholder="Outcome: what must be true when finished.\nConstraints: what must not change.\nVerification: how SideKick should prove it works."
          />
        </label>
        <div className="goal-dialog-hint">
          <span>
            {objective.length.toLocaleString()} / {CONVERSATION_GOAL_MAX_LENGTH.toLocaleString()}
          </span>
          <span>
            {submitShortcut} to {mode === 'create' ? 'start' : 'save'}
          </span>
        </div>
        {error && <p className="goal-dialog-error">{error}</p>}
        <footer className="goal-dialog-actions">
          <button type="button" className="goal-dialog-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="goal-dialog-submit"
            disabled={!objective.trim() || submitting}
            onClick={() => void submit()}
          >
            {submitting ? 'Saving…' : mode === 'create' ? 'Start goal' : 'Save changes'}
          </button>
        </footer>
      </section>
    </div>
  )
}
