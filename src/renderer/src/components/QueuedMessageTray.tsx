import { useEffect, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import TextareaAutosize from 'react-textarea-autosize'
import { ArrowUpToLine, Check, GripVertical, Pencil, Trash2, X } from 'lucide-react'
import type { PendingRunMessageItem } from '../hooks/useConversationRun'

interface QueuedMessageTrayProps {
  pivotMessage: PendingRunMessageItem | null
  queuedMessages: PendingRunMessageItem[]
  onUpdate: (id: string, content: string) => boolean
  onRemove: (id: string) => void
  onMove: (id: string, toIndex: number) => void
  onSteer: (id: string) => void
}

export function QueuedMessageTray({
  pivotMessage,
  queuedMessages,
  onUpdate,
  onRemove,
  onMove,
  onSteer
}: QueuedMessageTrayProps): React.JSX.Element | null {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const pendingCount = queuedMessages.length + (pivotMessage ? 1 : 0)
  useEffect(() => {
    if (!editingId) return
    editorRef.current?.focus()
    editorRef.current?.select()
  }, [editingId])

  if (!pendingCount) return null

  const beginEdit = (message: PendingRunMessageItem): void => {
    setEditingId(message.id)
    setDraft(message.content)
  }

  const cancelEdit = (): void => {
    setEditingId(null)
    setDraft('')
  }

  const saveEdit = (): void => {
    if (!editingId || !onUpdate(editingId, draft)) return
    cancelEdit()
  }

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelEdit()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      saveEdit()
    }
  }

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
    const isEditing = editingId === message.id
    return (
      <article
        key={message.id}
        className={`queued-message-card ${isPivot ? 'is-steering' : ''} ${draggedId === message.id ? 'is-dragging' : ''} ${dropTargetId === message.id ? 'is-drop-target' : ''}`.trim()}
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
          draggable={!isPivot && !isEditing}
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
          {isEditing ? (
            <TextareaAutosize
              ref={editorRef}
              className="queued-message-editor"
              value={draft}
              minRows={1}
              maxRows={6}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleEditorKeyDown}
              aria-label="Edit queued message"
            />
          ) : (
            <div
              className="queued-message-text"
              onDoubleClick={() => beginEdit(message)}
              title="Edit queued message"
            >
              {isPivot && <span className="queued-message-state">Steering</span>}
              {message.content ||
                (message.images?.length
                  ? 'Image attachment'
                  : message.attachments?.length
                    ? 'Project attachment'
                    : '')}
              {Boolean(message.images?.length) && (
                <span className="queued-message-image-count">
                  {message.images!.length} image{message.images!.length === 1 ? '' : 's'}
                </span>
              )}
              {Boolean(message.attachments?.length) && (
                <span className="queued-message-image-count">
                  {message.attachments!.length} file{message.attachments!.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="queued-message-actions">
          {isEditing ? (
            <>
              <button
                type="button"
                onClick={saveEdit}
                disabled={!draft.trim()}
                title="Save edit"
                aria-label="Save queued message edit"
              >
                <Check size={14} />
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                title="Discard edit"
                aria-label="Discard queued message edit"
              >
                <X size={14} />
              </button>
            </>
          ) : (
            <>
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
              <button
                type="button"
                onClick={() => beginEdit(message)}
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
