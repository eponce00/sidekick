import { useId, useState } from 'react'
import { Info, NotebookPen, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useModalDialog } from '../hooks/useModalDialog'
import './WorkspaceMemoryModal.css'

interface WorkspaceMemoryModalProps {
  isOpen: boolean
  workspaceFolder: string
  initialContent: string
  onClose: () => void
  onSaved: (content: string) => void
}

export function WorkspaceMemoryModal({
  isOpen,
  workspaceFolder,
  initialContent,
  onClose,
  onSaved
}: WorkspaceMemoryModalProps): React.JSX.Element | null {
  if (!isOpen) return null
  return (
    <WorkspaceMemoryForm
      key={`${workspaceFolder}\u0000${initialContent}`}
      workspaceFolder={workspaceFolder}
      initialContent={initialContent}
      onClose={onClose}
      onSaved={onSaved}
    />
  )
}

function WorkspaceMemoryForm({
  workspaceFolder,
  initialContent,
  onClose,
  onSaved
}: Omit<WorkspaceMemoryModalProps, 'isOpen'>): React.JSX.Element {
  const [content, setContent] = useState(initialContent)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const closeWhenIdle = (): void => {
    if (!saving) onClose()
  }
  const dialogRef = useModalDialog<HTMLDivElement>(true, closeWhenIdle)
  const titleId = useId()
  const descriptionId = useId()
  const fieldId = useId()
  const projectName = workspaceFolder.split(/[\\/]/).filter(Boolean).at(-1) || 'this project'
  const hasChanges = content.trim() !== initialContent.trim()

  const handleSave = async (): Promise<void> => {
    if (saving || !hasChanges) return
    setSaving(true)
    setError(null)
    try {
      const result = await window.api.memory.save(workspaceFolder, content)
      if (!result.ok) {
        setError(result.error ?? 'Could not save project notes')
        return
      }
      onSaved(result.content)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save project notes')
    } finally {
      setSaving(false)
    }
  }

  const dialog = (
    <div
      className="workspace-memory-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeWhenIdle()
      }}
    >
      <div
        ref={dialogRef}
        className="workspace-memory-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className="workspace-memory-header">
          <span className="workspace-memory-heading-icon" aria-hidden="true">
            <NotebookPen size={18} />
          </span>
          <div className="workspace-memory-heading-copy">
            <h2 id={titleId}>Project notes</h2>
            <p id={descriptionId}>
              Background context shared with every SideKick chat in <strong>{projectName}</strong>.
            </p>
          </div>
          <button
            type="button"
            className="workspace-memory-close"
            onClick={onClose}
            disabled={saving}
            title="Close project notes"
            aria-label="Close project notes"
          >
            <X size={17} />
          </button>
        </div>

        <div className="workspace-memory-body">
          <div className="workspace-memory-explainer">
            <Info size={15} aria-hidden="true" />
            <p>
              Use this for stable facts, decisions, and preferences. These notes are context—not
              rules. Put agent workflow rules in <code>AGENTS.md</code> instead.
            </p>
          </div>
          <label htmlFor={fieldId}>Notes shared with the model</label>
          <textarea
            id={fieldId}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            maxLength={64_000}
            placeholder="Stable project facts, decisions, user preferences, naming conventions…"
            autoFocus
          />
          <div className="workspace-memory-meta">
            <span>{content.length.toLocaleString()} / 64,000 characters</span>
            {error && (
              <span className="workspace-memory-error" role="alert">
                {error}
              </span>
            )}
          </div>
        </div>

        <div className="workspace-memory-footer">
          <span>Stored locally for this project</span>
          <button
            type="button"
            className="workspace-memory-button secondary"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="workspace-memory-button primary"
            onClick={() => void handleSave()}
            disabled={saving || !hasChanges}
          >
            {saving ? 'Saving…' : 'Save notes'}
          </button>
        </div>
      </div>
    </div>
  )

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}
