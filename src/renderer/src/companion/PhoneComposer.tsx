import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Camera,
  ChevronDown,
  FileText,
  Images,
  ListChecks,
  Loader2,
  Microscope,
  Pencil,
  Plus,
  Square,
  X
} from 'lucide-react'
import type { ConversationRunMode, PromptAdmissionsResult } from '../../../shared/agentRunApi'
import { MAX_MESSAGE_IMAGES } from '../../../shared/messageImages'
import '../components/ChatInput.css'
import { ChatComposer } from '../components/ChatComposer'
import { DictationButton } from '../components/DictationButton'
import { ImageAttachmentPreview } from '../components/ImageAttachmentPreview'
import { QueuedMessageTray } from '../components/QueuedMessageTray'
import { endDictation } from '../services/voice/dictationControl'
import { TEXT_FILE_ACCEPT } from './attachments'
import type { CompanionConnection } from './chatState'
import { useCompanionVoice } from './phoneVoice'
import { Sheet, SheetAction, SheetSection, SheetTile } from './Sheet'
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
  onSteerQueued
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
  editing: { messageId: string; text: string; nonce: number } | null
  onCancelEdit: () => void
  onSubmitEdit: (text: string) => Promise<boolean>
  onSend: (message: OutgoingMessage) => Promise<boolean>
  onStop: () => void
  onUpdateQueue: (queued: Array<{ id: string; content: string }>) => void
  onSteerQueued: (admissionId: string) => void
}) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<ConversationRunMode>('conversation')
  const [chosenModelId, setChosenModelId] = useState<string | null>(null)
  const [sheet, setSheet] = useState<'add' | 'model' | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const libraryInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const files = usePhoneAttachments(connection)
  const voice = useCompanionVoice()
  const closeSheet = useCallback(() => setSheet(null), [])
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
  const [edited, setEdited] = useState<number | null>(null)
  const setAside = useRef<string | null>(null)
  if (editing && editing.nonce !== edited) {
    setEdited(editing.nonce)
    if (setAside.current === null) setAside.current = text
    setText(editing.text)
  }
  useEffect(() => {
    if (!editing) return
    requestAnimationFrame(() => {
      const field = inputRef.current
      field?.focus()
      field?.setSelectionRange(editing.text.length, editing.text.length)
    })
  }, [editing])
  const endEdit = (): void => {
    setText(setAside.current ?? '')
    setAside.current = null
    setEdited(null)
  }

  const modelId = chosenModelId ?? models?.selectedModelId ?? null
  const model = models?.models.find((candidate) => candidate.id === modelId) ?? null
  const visionUnavailable = model?.supportsVision === false
  const hasContent = Boolean(text.trim() || files.attachments.length)
  // As on the desktop: an empty Send while SideKick works steers with the first queued message.
  const steerFirst = runActive && !hasContent && queue.queued.length > 0

  const submit = async (): Promise<void> => {
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
    setSheet(null)
    input.current?.click()
  }

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
        moveButtons
        onUpdate={(id, content) => {
          if (!content.trim()) return false
          onUpdateQueue(
            queue.queued.map((item) => ({
              id: item.id,
              content: item.id === id ? content.trim() : item.content
            }))
          )
          return true
        }}
        onRemove={(id) =>
          onUpdateQueue(
            queue.queued
              .filter((item) => item.id !== id)
              .map((item) => ({ id: item.id, content: item.content }))
          )
        }
        onMove={(id, toIndex) => {
          const order = queue.queued.filter((item) => item.id !== id)
          const moved = queue.queued.find((item) => item.id === id)
          if (!moved) return
          order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, moved)
          onUpdateQueue(order.map((item) => ({ id: item.id, content: item.content })))
        }}
        onSteer={onSteerQueued}
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
  const showSend = editing ? Boolean(text.trim()) : hasContent
  const showStop = runActive && !hasContent && !editing

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
          editing
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
          editing
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
        toolbarLeft={
          editing ? (
            <span className="cp-mode-chip is-editing" role="status">
              <Pencil size={15} aria-hidden="true" />
              Editing
              <button
                type="button"
                onClick={() => {
                  endEdit()
                  onCancelEdit()
                }}
                aria-label="Cancel the edit"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </span>
          ) : (
            <>
              <button
                type="button"
                className="cp-composer-button"
                onClick={() => setSheet('add')}
                aria-label="Add an attachment or agent behavior"
                aria-haspopup="dialog"
              >
                <Plus size={20} aria-hidden="true" />
              </button>
              {mode !== 'conversation' && (
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
              )}
            </>
          )
        }
        toolbarRight={
          <>
            {models && models.models.length > 0 && (
              <button
                type="button"
                className="cp-model-chip"
                onClick={() => setSheet('model')}
                aria-label={`Model: ${model?.name ?? 'choose one'}`}
                aria-haspopup="dialog"
              >
                <span>{model?.name ?? 'Choose model'}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            )}
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
      {sheet === 'add' && (
        <Sheet label="Add to message" onClose={closeSheet}>
          <div className="cp-sheet-tiles" role="group" aria-label="Attach">
            <SheetTile
              icon={<Camera size={22} />}
              label="Camera"
              disabled={Boolean(imageReason)}
              onClick={() => pick(cameraInput)}
            />
            <SheetTile
              icon={<Images size={22} />}
              label="Photos"
              disabled={Boolean(imageReason)}
              onClick={() => pick(libraryInput)}
            />
            <SheetTile
              icon={<FileText size={22} />}
              label="Files"
              onClick={() => pick(fileInput)}
            />
          </div>
          {imageReason && <p className="cp-sheet-note">{imageReason}</p>}
          <div className="cp-sheet-list" role="group" aria-label="Agent behavior">
            <SheetAction
              icon={<Microscope size={20} />}
              label="Research report"
              description="Search, cross-check, and cite web sources"
              selected={mode === 'research'}
              onClick={() => {
                setMode((current) => (current === 'research' ? 'conversation' : 'research'))
                setSheet(null)
              }}
            />
            <SheetAction
              icon={<ListChecks size={20} />}
              label="Plan first"
              description="Review a plan before SideKick changes project files"
              selected={mode === 'plan'}
              onClick={() => {
                setMode((current) => (current === 'plan' ? 'conversation' : 'plan'))
                setSheet(null)
              }}
            />
          </div>
        </Sheet>
      )}
      {sheet === 'model' && models && (
        <Sheet label="Choose the model" onClose={closeSheet}>
          <SheetSection label="Model for this chat">
            {models.models.map((candidate) => (
              <SheetAction
                key={candidate.id}
                label={candidate.name}
                description={candidate.supportsVision ? 'Sees images' : 'Text only'}
                selected={candidate.id === modelId}
                onClick={() => {
                  setChosenModelId(candidate.id)
                  setSheet(null)
                }}
              />
            ))}
          </SheetSection>
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
