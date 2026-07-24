import { useState } from 'react'
import { X } from 'lucide-react'
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
      key={initialContent}
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
  const dialogRef = useModalDialog<HTMLDivElement>(true, onClose)

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const result = await window.api.memory.save(workspaceFolder, content)
    setSaving(false)
    if (!result.ok) {
      setError(result.error ?? 'Could not save project memory')
      return
    }
    onSaved(result.content)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-content workspace-memory-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-memory-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="workspace-memory-title">Project Memory</h2>
            <p>Durable notes shared by every conversation in this project folder.</p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            title="Close"
            aria-label="Close project memory"
          >
            <X size={17} />
          </button>
        </div>
        <div className="modal-body">
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            maxLength={64_000}
            placeholder="Project decisions, user preferences, recurring workflows, important constraints…"
            autoFocus
          />
          <div className="workspace-memory-meta">
            <span>{content.length.toLocaleString()} / 64,000 characters</span>
            {error && <span className="workspace-memory-error">{error}</span>}
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Memory'}
          </button>
        </div>
      </div>
    </div>
  )
}
