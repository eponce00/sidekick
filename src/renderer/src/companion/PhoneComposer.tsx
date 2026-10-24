import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  Brain,
  Camera,
  ChevronRight,
  RotateCcw,
  Pencil,
  Trash2,
  FileText,
  Images,
  ListChecks,
  Loader2,
  Microscope,
  Plus,
  Sparkles,
  Square,
  X
} from 'lucide-react'
import type { ConversationRunMode, PromptAdmissionsResult } from '../../../shared/agentRunApi'
import { REASONING_LEVEL_LABELS, type ReasoningLevel } from '../../../shared/reasoning'
import { MAX_MESSAGE_IMAGES } from '../../../shared/messageImages'
import '../components/ChatInput.css'
import { ChatComposer } from '../components/ChatComposer'
import { ComposerEditingBar } from '../components/ComposerEditingBar'
import { EffortSlider } from '../components/EffortSlider'
import { DictationButton } from '../components/DictationButton'
import { ImageAttachmentPreview } from '../components/ImageAttachmentPreview'
import { QueuedMessageTray } from '../components/QueuedMessageTray'
import { endDictation } from '../services/voice/dictationControl'
import { flyIntoComposer } from '../utils/flyIntoComposer'
import { TEXT_FILE_ACCEPT } from './attachments'
import type { CompanionConnection } from './chatState'
import { phoneNotice } from './phoneApi'
import { useCompanionVoice } from './phoneVoice'
import { Popover, PopoverItem } from './Popover'
import { Sheet, SheetAction } from './Sheet'
import type { ModelList, OutgoingMessage } from './useCompanionChat'
import { usePhoneAttachments } from './usePhoneAttachments'

/** The chip a chosen mode shows in the message box, as the phone apps show an active tool. */
const MODE_CHIP: Record<Exclude<ConversationRunMode, 'conversation'>, string> = {
  research: 'Research',
  plan: 'Plan'
}

/**
 * The desktop's message box as one card, laid out like the ChatGPT and Claude apps': the text on
 * top, then + on the left, and the model, the microphone and one round button on the right. That
 * button sends once there is something to send and stops SideKick while it works with nothing
 * typed. Attachments, Plan and Research come from the + sheet, the model from its own. While
 * SideKick works, Send queues the message behind the run, as on the desktop; each queued message
 * can steer the run now, and Ctrl+Enter in an empty box steers with the first.
 */
export function PhoneComposer({
  connection,
  runActive,
  sending,
  stopping,
  queue,
  models,
  prefill,
  editing,
  onCancelEdit,
  onSubmitEdit,
  onSend,
  onStop,
  onUpdateQueue,
  onSteerQueued,
  onEffortChange
}: {
  connection: CompanionConnection
  runActive: boolean
  sending: boolean
  stopping: boolean
  queue: PromptAdmissionsResult
  models: ModelList | null
  /** Text put in the box for review, as a home suggestion does; a new nonce puts it again. */
  prefill?: { text: string; nonce: number } | null
  /**
   * A sent message being edited, as the desktop's Edit loads one into the box: sending answers it
   * again with the new text. What the box held waits until the edit is sent or cancelled.
   */
  editing: {
    messageId: string
    text: string
    nonce: number
    /** Where the message is on screen, which it moves into the box from. */
    source: HTMLElement | null
  } | null
  onCancelEdit: () => void
  onSubmitEdit: (text: string) => Promise<boolean>
  onSend: (message: OutgoingMessage) => Promise<boolean>
  onStop: () => void
  onUpdateQueue: (queued: Array<{ id: string; content: string }>) => void
  onSteerQueued: (admissionId: string) => void
  /** How hard a model thinks, as the desktop's reasoning slider sets it. */
  onEffortChange: (modelId: string, level: ReasoningLevel) => void
}) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<ConversationRunMode>('conversation')
  const [chosenModelId, setChosenModelId] = useState<string | null>(null)
  // The + menu, opened above its button, and its list of models.
  const [menu, setMenu] = useState<'add' | 'effort' | 'model' | null>(null)
  const [plusAnchor, setPlusAnchor] = useState<HTMLElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const libraryInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const files = usePhoneAttachments(connection)
  const voice = useCompanionVoice()
  const closeMenu = useCallback(() => setMenu(null), [])
  // A new suggestion replaces the text while rendering, so the box never shows the old text first.
  const [prefilled, setPrefilled] = useState<number | null>(null)
  if (prefill && prefill.nonce !== prefilled) {
    setPrefilled(prefill.nonce)
    setText(prefill.text)
  }
  useEffect(() => {
    if (!prefill) return
    requestAnimationFrame(() => {
      const field = inputRef.current
      field?.focus()
      field?.setSelectionRange(prefill.text.length, prefill.text.length)
    })
  }, [prefill])
  // A queued message is edited in the box as a sent one is: its text in the box, with an Editing
  // chip. Sending saves it in the queue instead of answering anything again.
  const [queuedEdit, setQueuedEdit] = useState<{
    id: string
    text: string
    nonce: number
    source: HTMLElement | null
  } | null>(null)
  const activeEdit = queuedEdit ?? editing
  // The queued message whose actions are open in a sheet, and where it is on screen.
  const [queuedMenu, setQueuedMenu] = useState<{
    message: { id: string; content: string }
    source: HTMLElement | null
  } | null>(null)
  const closeQueuedMenu = useCallback(() => setQueuedMenu(null), [])
  const [edited, setEdited] = useState<number | null>(null)
  const setAside = useRef<string | null>(null)
  if (activeEdit && activeEdit.nonce !== edited) {
    setEdited(activeEdit.nonce)
    if (setAside.current === null) setAside.current = text
    setText(activeEdit.text)
  }
  useEffect(() => {
    if (!activeEdit) return
    // After the editing bar has rendered, so the message lands where its text now sits.
    requestAnimationFrame(() => {
      const field = inputRef.current
      if (!field) return
      flyIntoComposer(activeEdit.source, field.closest<HTMLElement>('.input-container'))
      field.focus()
      field.setSelectionRange(activeEdit.text.length, activeEdit.text.length)
    })
  }, [activeEdit])
  const endEdit = (): void => {
    setText(setAside.current ?? '')
    setAside.current = null
    setEdited(null)
  }
  const cancelEdit = (): void => {
    endEdit()
    if (queuedEdit) setQueuedEdit(null)
    else onCancelEdit()
  }

  const modelId = chosenModelId ?? models?.selectedModelId ?? null
  const model = models?.models.find((candidate) => candidate.id === modelId) ?? null
  const visionUnavailable = model?.supportsVision === false
  const hasContent = Boolean(text.trim() || files.attachments.length)
  // As on the desktop: an empty Send while SideKick works steers with the first queued message.
  const steerFirst = runActive && !hasContent && queue.queued.length > 0

  const submit = async (): Promise<void> => {
    if (queuedEdit) {
      const edit = text.trim()
      if (!edit) return
      endDictation()
      if (!queue.queued.some((item) => item.id === queuedEdit.id)) {
        // It was sent while being edited; the new text stays in the box to send.
        setQueuedEdit(null)
        setAside.current = null
        setEdited(null)
        phoneNotice('That message was already sent.')
        return
      }
      onUpdateQueue(
        queue.queued.map((item) => ({
          id: item.id,
          content: item.id === queuedEdit.id ? edit : item.content
        }))
      )
      setQueuedEdit(null)
      endEdit()
      return
    }
    if (editing) {
      const edit = text.trim()
      if (!edit || sending) return
      endDictation()
      if (await onSubmitEdit(edit)) endEdit()
      return
    }
    if (steerFirst) {
      onSteerQueued(queue.queued[0].id)
      return
    }
    if (!hasContent || sending || files.uploading) return
    // What was dictated goes with the message, and the microphone stops.
    endDictation()
    const message = text.trim()
    const attached = files.take()
    setText('')
    const sent = await onSend({
      text: message,
      mode,
      ...(chosenModelId ? { modelId: chosenModelId } : {}),
      images: attached.flatMap((attachment) =>
        attachment.kind === 'image' && attachment.uploadId && attachment.preview
          ? [{ uploadId: attachment.uploadId, preview: attachment.preview }]
          : []
      ),
      files: attached.flatMap((attachment) =>
        attachment.kind === 'text' && attachment.uploadId
          ? [{ uploadId: attachment.uploadId, name: attachment.name }]
          : []
      )
    })
    if (sent) {
      // A mode is for the message it was chosen for, as on the desktop.
      setMode('conversation')
      return
    }
    // Nothing typed or attached is lost when the send fails.
    setText((current) => current || message)
    files.restore(attached)
  }

  const pick = (input: React.RefObject<HTMLInputElement | null>): void => {
    setMenu(null)
    input.current?.click()
  }

  const editQueued = (message: { id: string; content: string }, source: HTMLElement | null): void =>
    setQueuedEdit({ id: message.id, text: message.content, nonce: Date.now(), source })
  const removeQueued = (id: string): void =>
    onUpdateQueue(
      queue.queued
        .filter((item) => item.id !== id)
        .map((item) => ({ id: item.id, content: item.content }))
    )
  const moveQueued = (id: string, toIndex: number): void => {
    const order = queue.queued.filter((item) => item.id !== id)
    const moved = queue.queued.find((item) => item.id === id)
    if (!moved) return
    order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, moved)
    onUpdateQueue(order.map((item) => ({ id: item.id, content: item.content })))
  }
  const queuedMenuIndex = queuedMenu
    ? queue.queued.findIndex((item) => item.id === queuedMenu.message.id)
    : -1

  const imagesFull = files.imageCount >= MAX_MESSAGE_IMAGES
  const imageReason = visionUnavailable
    ? 'This chat’s model cannot see images'
    : imagesFull
      ? `Up to ${MAX_MESSAGE_IMAGES} images a message`
      : undefined

  const queueTray =
    queue.queued.length || queue.pivot ? (
      <QueuedMessageTray
        queuedMessages={queue.queued}
        pivotMessage={queue.pivot}
        onEdit={editQueued}
        onRemove={removeQueued}
        onMove={moveQueued}
        onSteer={onSteerQueued}
        onOpenActions={(message, source) => setQueuedMenu({ message, source })}
        editingId={queuedEdit?.id ?? null}
      />
    ) : undefined

  const attachmentTray =
    files.attachments.length || files.error ? (
      <div className="composer-attachments" aria-label="Message attachments">
        {files.attachments.map((attachment) =>
          attachment.kind === 'image' ? (
            <div className="composer-attachment" key={attachment.id}>
              {attachment.preview ? (
                <ImageAttachmentPreview
                  image={attachment.preview}
                  className="composer-image-preview"
                />
              ) : (
                <span className="cp-attachment-preparing" aria-label="Preparing the photo">
                  <Loader2 size={16} className="icon-spin" aria-hidden="true" />
                </span>
              )}
              {!attachment.uploadId && <UploadProgress value={attachment.progress} />}
              <button
                type="button"
                className="composer-attachment-remove"
                onClick={() => files.remove(attachment.id)}
                title={`Remove ${attachment.name}`}
                aria-label={`Remove ${attachment.name}`}
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <div
              className="composer-context-attachment cp-file-chip"
              key={attachment.id}
              title={attachment.name}
            >
              <FileText size={15} aria-hidden="true" />
              <span>{attachment.name}</span>
              {!attachment.uploadId && <UploadProgress value={attachment.progress} />}
              <button
                type="button"
                onClick={() => files.remove(attachment.id)}
                title={`Remove ${attachment.name}`}
                aria-label={`Remove ${attachment.name}`}
              >
                <X size={11} />
              </button>
            </div>
          )
        )}
        {files.error && (
          <span className="composer-attachment-error" role="alert">
            {files.error}
          </span>
        )}
      </div>
    ) : undefined

  // One round button at the end of the row, as in the phone apps: Send once there is something to
  // send, Stop while SideKick works with nothing typed. A queued message steers from its own Steer
  // button, or with Ctrl+Enter in an empty box on a hardware keyboard.
  const showSend = activeEdit ? Boolean(text.trim()) : hasContent
  const showStop = runActive && !hasContent && !activeEdit

  return (
    <>
      <ChatComposer
        className="cp-input-area"
        value={text}
        inputRef={inputRef}
        autoFocus={false}
        minRows={1}
        maxRows={6}
        placeholder={
          activeEdit
            ? 'Edit your message'
            : mode === 'research'
              ? 'What should SideKick research?'
              : mode === 'plan'
                ? 'What should SideKick plan?'
                : runActive
                  ? 'Queue a message for SideKick'
                  : 'Message SideKick'
        }
        queueTray={queueTray}
        attachmentTray={attachmentTray}
        onChange={setText}
        onKeyDown={(event) => {
          // Enter makes a new line on a phone keyboard; a hardware keyboard sends with Ctrl+Enter.
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            void submit()
          }
        }}
        onSend={() => void submit()}
        sendDisabled={!showSend || sending || files.uploading}
        sendButtonClassName={showSend ? '' : 'cp-hidden'}
        sendTitle={
          queuedEdit
            ? 'Save the queued message'
            : editing
              ? 'Send the edited message'
              : files.uploading
                ? 'Waiting for attachments to upload'
                : runActive
                  ? 'Add message to queue'
                  : mode === 'research'
                    ? 'Start research report'
                    : mode === 'plan'
                      ? 'Start Plan mode'
                      : 'Send message'
        }
        contextBar={
          activeEdit ? (
            <ComposerEditingBar queued={Boolean(queuedEdit)} onCancel={cancelEdit} />
          ) : mode !== 'conversation' ? (
            // A chosen mode, as the phone apps show an active tool: a chip that removes it.
            <span className="cp-mode-chip" role="status">
              {mode === 'plan' ? (
                <ListChecks size={15} aria-hidden="true" />
              ) : (
                <Microscope size={15} aria-hidden="true" />
              )}
              {MODE_CHIP[mode]}
              <button
                type="button"
                onClick={() => setMode('conversation')}
                aria-label={mode === 'plan' ? 'Remove Plan mode' : 'Remove research mode'}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </span>
          ) : undefined
        }
        toolbarLeft={
          activeEdit ? undefined : (
            <>
              <button
                type="button"
                className="cp-composer-button"
                onClick={(event) => {
                  setPlusAnchor(event.currentTarget)
                  setMenu('add')
                }}
                aria-label="Add an attachment, a mode or the model"
                aria-haspopup="menu"
                aria-expanded={menu !== null}
              >
                <Plus size={22} aria-hidden="true" />
              </button>
            </>
          )
        }
        toolbarRight={
          <>
            {voice?.dictation && (
              <DictationButton inputRef={inputRef} onInputChange={setText} phone />
            )}
            {showStop && (
              <button
                type="button"
                className={`stop-button ${stopping ? 'is-stopping' : ''}`}
                onClick={onStop}
                disabled={stopping}
                title={stopping ? 'Stopping...' : 'Stop generation'}
                aria-label={stopping ? 'Stopping' : 'Stop generation'}
              >
                <Square size={13} fill="currentColor" />
              </button>
            )}
          </>
        }
      />
      <input
        ref={libraryInput}
        className="composer-image-input"
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const chosen = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (chosen.length) files.addImages(chosen)
        }}
      />
      <input
        ref={cameraInput}
        className="composer-image-input"
        type="file"
        accept="image/*"
        capture="environment"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const chosen = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (chosen.length) files.addImages(chosen)
        }}
      />
      <input
        ref={fileInput}
        className="composer-image-input"
        type="file"
        accept={TEXT_FILE_ACCEPT}
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const chosen = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (chosen.length) files.addTextFiles(chosen)
        }}
      />
      {menu === 'add' && (
        <Popover
          label="Add to message"
          anchor={plusAnchor}
          placement="above-start"
          onClose={closeMenu}
        >
          <PopoverItem
            round
            icon={<Camera size={20} />}
            label="Camera"
            disabled={Boolean(imageReason)}
            onClick={() => pick(cameraInput)}
          />
          <PopoverItem
            round
            icon={<Images size={20} />}
            label="Photos"
            disabled={Boolean(imageReason)}
            onClick={() => pick(libraryInput)}
          />
          <PopoverItem
            round
            icon={<FileText size={20} />}
            label="Files"
            onClick={() => pick(fileInput)}
          />
          {imageReason && <p className="cp-popover-note">{imageReason}</p>}
          <div className="cp-popover-divider" role="separator" />
          <PopoverItem
            round
            icon={<Microscope size={20} />}
            label="Research report"
            selected={mode === 'research'}
            onClick={() => {
              setMode((current) => (current === 'research' ? 'conversation' : 'research'))
              setMenu(null)
            }}
          />
          <PopoverItem
            round
            icon={<ListChecks size={20} />}
            label="Plan first"
            selected={mode === 'plan'}
            onClick={() => {
              setMode((current) => (current === 'plan' ? 'conversation' : 'plan'))
              setMenu(null)
            }}
          />
          {models && models.models.length > 0 && (
            <PopoverItem
              round
              icon={<Sparkles size={20} />}
              label={model?.name ?? 'Choose model'}
              description={
                model?.reasoning
                  ? `Reasoning: ${REASONING_LEVEL_LABELS[model.reasoning.level]}`
                  : 'Model'
              }
              submenu
              onClick={() => setMenu(model?.reasoning ? 'effort' : 'model')}
            />
          )}
        </Popover>
      )}
      {menu === 'effort' && model?.reasoning && (
        <Popover
          label="Reasoning"
          anchor={plusAnchor}
          placement="above-start"
          title="Reasoning"
          onBack={() => setMenu('add')}
          onClose={closeMenu}
        >
          <div className="cp-effort">
            <div className="effort-card-head">
              <Brain size={18} className="effort-card-icon" aria-hidden="true" />
              <strong className="effort-card-level">
                {REASONING_LEVEL_LABELS[model.reasoning.level]}
              </strong>
              <button
                type="button"
                className="effort-card-reset"
                disabled={model.reasoning.level === model.reasoning.initial}
                onClick={() => onEffortChange(model.id, model.reasoning!.initial)}
                aria-label="Back to the starting level"
              >
                <RotateCcw size={17} aria-hidden="true" />
              </button>
            </div>
            <button type="button" className="effort-card-model" onClick={() => setMenu('model')}>
              <span>{model.name}</span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
            <EffortSlider
              levels={model.reasoning.levels}
              level={model.reasoning.level}
              onChange={(level) => onEffortChange(model.id, level)}
            />
            {model.reasoning.levels.includes('auto') && (
              <button
                type="button"
                className={`effort-card-default${model.reasoning.level === 'auto' ? ' is-selected' : ''}`}
                aria-pressed={model.reasoning.level === 'auto'}
                onClick={() => onEffortChange(model.id, 'auto')}
              >
                Let the model decide
              </button>
            )}
          </div>
        </Popover>
      )}
      {menu === 'model' && models && (
        <Popover
          label="Choose the model"
          anchor={plusAnchor}
          placement="above-start"
          title="Model for this chat"
          onBack={() => setMenu(model?.reasoning ? 'effort' : 'add')}
          onClose={closeMenu}
        >
          {models.models.map((candidate) => (
            <PopoverItem
              key={candidate.id}
              label={candidate.name}
              description={candidate.supportsVision ? 'Sees images' : 'Text only'}
              selected={candidate.id === modelId}
              onClick={() => {
                setChosenModelId(candidate.id)
                setMenu(null)
              }}
            />
          ))}
        </Popover>
      )}
      {queuedMenu && (
        <Sheet label="Queued message" onClose={closeQueuedMenu}>
          <p className="cp-sheet-quote">{queuedMenu.message.content}</p>
          {runActive && queuedMenuIndex >= 0 && (
            <SheetAction
              icon={<ArrowUpToLine size={20} />}
              label="Steer now"
              description="Hand it to SideKick while it works"
              onClick={() => {
                setQueuedMenu(null)
                onSteerQueued(queuedMenu.message.id)
              }}
            />
          )}
          <SheetAction
            icon={<Pencil size={20} />}
            label="Edit"
            onClick={() => {
              setQueuedMenu(null)
              editQueued(queuedMenu.message, queuedMenu.source)
            }}
          />
          {queue.queued.length > 1 && queuedMenuIndex >= 0 && (
            <>
              <SheetAction
                icon={<ArrowUp size={20} />}
                label="Move up"
                disabled={queuedMenuIndex === 0}
                onClick={() => {
                  setQueuedMenu(null)
                  moveQueued(queuedMenu.message.id, queuedMenuIndex - 1)
                }}
              />
              <SheetAction
                icon={<ArrowDown size={20} />}
                label="Move down"
                disabled={queuedMenuIndex === queue.queued.length - 1}
                onClick={() => {
                  setQueuedMenu(null)
                  moveQueued(queuedMenu.message.id, queuedMenuIndex + 1)
                }}
              />
            </>
          )}
          {queuedMenuIndex >= 0 && (
            <SheetAction
              icon={<Trash2 size={20} />}
              label="Remove"
              tone="danger"
              onClick={() => {
                setQueuedMenu(null)
                removeQueued(queuedMenu.message.id)
              }}
            />
          )}
        </Sheet>
      )}
    </>
  )
}

function UploadProgress({ value }: { value: number }) {
  return (
    <span
      className="cp-upload-progress"
      role="progressbar"
      aria-label="Uploading"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
    >
      <span style={{ width: `${Math.max(4, value * 100)}%` }} />
    </span>
  )
}
