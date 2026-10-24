import { Pencil, X } from 'lucide-react'

/**
 * The bar above the message box while it holds a message being edited: a sent one, which sending
 * answers again, or a queued one, which sending saves back in the queue.
 */
export function ComposerEditingBar({
  queued,
  onCancel
}: {
  queued: boolean
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="composer-editing-bar" role="status">
      <Pencil size={13} aria-hidden="true" />
      <strong>{queued ? 'Editing a queued message' : 'Editing your message'}</strong>
      <span>
        {queued ? 'Sending saves it in the queue.' : 'Sending replaces it and everything after it.'}
      </span>
      <button
        type="button"
        className="composer-editing-cancel"
        onClick={onCancel}
        title="Cancel the edit (Esc)"
        aria-label="Cancel the edit"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
