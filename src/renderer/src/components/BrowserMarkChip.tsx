import { X } from 'lucide-react'
import type { BrowserAnnotationAttachment } from '../../../shared/messageContextAttachments'
import './BrowserMarkChip.css'

/**
 * A place the user marked on a page, numbered as the page shows it, with their note. In the
 * composer it can be removed; in a sent message it is a record of what went with it.
 */
export function BrowserMarkChip({
  mark,
  className,
  onRemove
}: {
  mark: Pick<BrowserAnnotationAttachment, 'number' | 'name' | 'note' | 'url'>
  className: string
  onRemove?: () => void
}): React.JSX.Element {
  const note = mark.note.trim()
  return (
    <div
      className={`${className} browser-mark-chip`}
      title={[`${mark.number}. ${mark.name}`, mark.url, note].filter(Boolean).join('\n')}
    >
      <span className="browser-mark-number" aria-hidden="true">
        {mark.number}
      </span>
      <span>
        <span className="visually-hidden">Mark {mark.number}: </span>
        <strong>{mark.name}</strong>
        {note && <span className="browser-mark-note"> · {note}</span>}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title={`Remove mark ${mark.number}`}
          aria-label={`Remove mark ${mark.number}, ${mark.name}`}
        >
          <X size={11} />
        </button>
      )}
    </div>
  )
}
