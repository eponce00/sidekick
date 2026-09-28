import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ClipboardPaste, Copy, TextCursorInput, Trash2, X } from 'lucide-react'
import {
  pastedTextLineCount,
  type PastedTextAttachment
} from '../../../shared/messageContextAttachments'
import { useModalDialog } from '../hooks/useModalDialog'
import './PastedTextAttachment.css'

interface PastedTextAttachmentCardProps {
  attachment: PastedTextAttachment
  /** In the composer the paste can still be removed or turned back into typed text. */
  onRemove?: () => void
  onInsert?: () => void
}

/** The opening of a paste: enough to recognize it without rendering all of it. */
const PREVIEW_CHARACTERS = 320

function lineLabel(lines: number): string {
  return `${lines.toLocaleString()} line${lines === 1 ? '' : 's'}`
}

export function PastedTextAttachmentCard({
  attachment,
  onRemove,
  onInsert
}: PastedTextAttachmentCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const lines = pastedTextLineCount(attachment.content)

  return (
    <div className="pasted-text-card">
      <button
        type="button"
        className="pasted-text-card-open"
        onClick={(event) => {
          event.stopPropagation()
          setOpen(true)
        }}
        title="View pasted text"
        aria-label={`View pasted text, ${lineLabel(lines)}: ${attachment.name}`}
      >
        <span className="pasted-text-card-preview" aria-hidden="true">
          {attachment.content.slice(0, PREVIEW_CHARACTERS)}
        </span>
        <span className="pasted-text-card-label" aria-hidden="true">
          <ClipboardPaste size={11} />
          Pasted · {lineLabel(lines)}
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          className="pasted-text-card-remove"
          onClick={onRemove}
          title="Remove pasted text"
          aria-label="Remove pasted text"
        >
          <X size={11} />
        </button>
      )}
      {open &&
        createPortal(
          <PastedTextDialog
            attachment={attachment}
            onClose={() => setOpen(false)}
            onRemove={
              onRemove &&
              (() => {
                setOpen(false)
                onRemove()
              })
            }
            onInsert={
              onInsert &&
              (() => {
                setOpen(false)
                onInsert()
              })
            }
          />,
          document.body
        )}
    </div>
  )
}

interface PastedTextDialogProps {
  attachment: PastedTextAttachment
  onClose: () => void
  onRemove?: () => void
  onInsert?: () => void
}

function PastedTextDialog({
  attachment,
  onClose,
  onRemove,
  onInsert
}: PastedTextDialogProps): React.JSX.Element {
  const dialogRef = useModalDialog<HTMLDivElement>(true, onClose)
  const titleId = useId()
  const [copied, setCopied] = useState(false)
  const lines = pastedTextLineCount(attachment.content)

  return (
    <div
      className="pasted-text-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="pasted-text-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="pasted-text-dialog-header">
          <ClipboardPaste size={16} aria-hidden="true" />
          <div>
            <h2 id={titleId}>Pasted text</h2>
            <p>
              {lineLabel(lines)} · {attachment.content.length.toLocaleString()} characters
            </p>
          </div>
          <button type="button" onClick={onClose} title="Close" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <pre className="pasted-text-dialog-body" tabIndex={0}>
          {attachment.content}
        </pre>
        <div className="pasted-text-dialog-footer">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(attachment.content).then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              })
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {onInsert && (
            <button type="button" onClick={onInsert}>
              <TextCursorInput size={14} />
              Insert as text
            </button>
          )}
          {onRemove && (
            <button type="button" className="pasted-text-dialog-remove" onClick={onRemove}>
              <Trash2 size={14} />
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
