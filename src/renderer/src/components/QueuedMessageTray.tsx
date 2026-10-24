import { useState } from 'react'
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react'
import { ArrowUpToLine, GripVertical, Pencil, Trash2 } from 'lucide-react'
import type { PendingRunMessageItem } from '../hooks/useConversationRun'
import {
  isPastedTextAttachment,
  isReviewCommentAttachment,
  type MessageContextAttachment
} from '../../../shared/messageContextAttachments'

function attachmentCountLabel(attachments: readonly MessageContextAttachment[]): string {
  const pasted = attachments.filter(isPastedTextAttachment).length
  const comments = attachments.filter(isReviewCommentAttachment).length
  const project = attachments.length - pasted - comments
  return [
    project ? `${project} file${project === 1 ? '' : 's'}` : '',
    pasted ? `${pasted} paste${pasted === 1 ? '' : 's'}` : '',
    comments ? `${comments} comment${comments === 1 ? '' : 's'}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
}

interface QueuedMessageTrayProps {
  pivotMessage: PendingRunMessageItem | null
  queuedMessages: PendingRunMessageItem[]
  /**
   * Edits a message in the message box, as a sent message is edited; `source` is its text on
   * screen, which moves into the box.
   */
  onEdit: (message: PendingRunMessageItem, source: HTMLElement | null) => void
  onRemove: (id: string) => void
  onMove: (id: string, toIndex: number) => void
  onSteer: (id: string) => void
  /**
   * For touch screens, where dragging does not reorder and a row of small buttons is hard to hit:
   * a tap on a message opens its actions (steer, edit, move, remove) instead, and only Steer stays
   * on the row.
   */
  onOpenActions?: (message: PendingRunMessageItem, source: HTMLElement | null) => void
  /** The message the message box is editing, which steps back as an edited sent message does. */
  editingId?: string | null
}

export function QueuedMessageTray({
  pivotMessage,
  queuedMessages,
  onEdit,
  onRemove,
  onMove,
  onSteer,
  onOpenActions,
  editingId = null
}: QueuedMessageTrayProps): React.JSX.Element | null {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const pendingCount = queuedMessages.length + (pivotMessage ? 1 : 0)

  if (!pendingCount) return null

  /** The message's text, which moves into the box, from anywhere in its card. */
  const textOf = (element: HTMLElement): HTMLElement | null =>
    element.closest('.queued-message-card')?.querySelector<HTMLElement>('.queued-message-text') ??
    null

  const handleDrop = (event: DragEvent<HTMLElement>, targetId: string): void => {
    event.preventDefault()
    if (!draggedId || draggedId === targetId) {
      setDraggedId(null)
      setDropTargetId(null)
      return
    }
    const targetIndex = queuedMessages.findIndex(({ id }) => id === targetId)
    if (targetIndex >= 0) onMove(draggedId, targetIndex)
    setDraggedId(null)
    setDropTargetId(null)
  }

  const renderMessage = (
    message: PendingRunMessageItem,
    index: number,
    isPivot: boolean
  ): React.JSX.Element => {
    const textHandlers = onOpenActions
      ? {
          role: 'button',
          tabIndex: 0,
          onClick: (event: MouseEvent<HTMLElement>) => onOpenActions(message, event.currentTarget),
          onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            onOpenActions(message, event.currentTarget)
          },
          'aria-label': `Actions for ${message.content || 'the queued message'}`
        }
      : {
          onDoubleClick: (event: MouseEvent<HTMLElement>) => onEdit(message, event.currentTarget),
          title: 'Edit queued message'
        }
    return (
      <article
        key={message.id}
        className={`queued-message-card ${isPivot ? 'is-steering' : ''} ${draggedId === message.id ? 'is-dragging' : ''} ${dropTargetId === message.id ? 'is-drop-target' : ''} ${editingId === message.id ? 'is-editing' : ''}`.trim()}
        onDragOver={(event) => {
          if (isPivot || !draggedId || draggedId === message.id) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDropTargetId(message.id)
        }}
        onDragLeave={() => {
          if (dropTargetId === message.id) setDropTargetId(null)
        }}
        onDrop={(event) => handleDrop(event, message.id)}
        data-pending-message-id={message.id}
        aria-label={isPivot ? 'Message steering next' : `Queued message ${index + 1}`}
      >
        <span
          className="queued-message-handle"
          aria-hidden="true"
          draggable={!isPivot && !onOpenActions}
          onDragStart={(event) => {
            setDraggedId(message.id)
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', message.id)
          }}
          onDragEnd={() => {
            setDraggedId(null)
            setDropTargetId(null)
          }}
        >
          {isPivot ? <span className="queued-message-pulse" /> : <GripVertical size={15} />}
        </span>
        <div className="queued-message-body">
          <div className="queued-message-text" {...textHandlers}>
            {isPivot && <span className="queued-message-state">Steering</span>}
            {message.content ||
              (message.images?.length
                ? 'Image attachment'
                : message.attachments?.length
                  ? message.attachments.some(isPastedTextAttachment)
                    ? 'Pasted text'
                    : message.attachments.some(isReviewCommentAttachment)
                      ? 'Comment on changes'
                      : 'Project attachment'
                  : '')}
            {Boolean(message.images?.length) && (
              <span className="queued-message-image-count">
                {message.images!.length} image{message.images!.length === 1 ? '' : 's'}
              </span>
            )}
            {Boolean(message.attachments?.length) && (
              <span className="queued-message-image-count">
                {attachmentCountLabel(message.attachments!)}
              </span>
            )}
          </div>
        </div>
        <div className="queued-message-actions">
          {!isPivot && (
            <button
              type="button"
              onClick={() => onSteer(message.id)}
              title="Steer with this message now"
              aria-label="Steer with queued message now"
            >
              <ArrowUpToLine size={14} />
              <span>Steer</span>
            </button>
          )}
          {!onOpenActions && (
            <>
              <button
                type="button"
                onClick={(event) => onEdit(message, textOf(event.currentTarget))}
                title="Edit queued message"
                aria-label="Edit queued message"
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                className="is-remove"
                onClick={() => onRemove(message.id)}
                title="Remove queued message"
                aria-label="Remove queued message"
              >
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
      </article>
    )
  }

  return (
    <section className="queued-message-tray" aria-label="Queued messages">
      <div className="queued-message-list">
        {pivotMessage && renderMessage(pivotMessage, 0, true)}
        {queuedMessages.map((message, index) => renderMessage(message, index, false))}
      </div>
    </section>
  )
}
