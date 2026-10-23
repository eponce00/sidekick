import { useCallback, useRef, useState } from 'react'
import {
  Camera,
  ChevronDown,
  Eye,
  FileText,
  ImagePlus,
  ListChecks,
  Loader2,
  Microscope,
  Plus,
  Sparkles,
  Square,
  X
} from 'lucide-react'
import type { ConversationRunMode, PromptAdmissionsResult } from '../../../shared/agentRunApi'
import { MAX_MESSAGE_IMAGES } from '../../../shared/messageImages'
import '../components/ChatInput.css'
import { ChatComposer } from '../components/ChatComposer'
import { ImageAttachmentPreview } from '../components/ImageAttachmentPreview'
import { QueuedMessageTray } from '../components/QueuedMessageTray'
import { TEXT_FILE_ACCEPT } from './attachments'
import { insertAtCursor, type CompanionConnection } from './chatState'
import { PhoneDictation } from './PhoneDictation'
import { useCompanionVoice } from './phoneVoice'
import { Sheet, SheetAction, SheetSection } from './Sheet'
import type { ModelList, OutgoingMessage } from './useCompanionChat'
import { usePhoneAttachments } from './usePhoneAttachments'

const MODE_COPY: Record<Exclude<ConversationRunMode, 'conversation'>, [string, string]> = {
  research: ['Research report', 'One response · web sources · cross-checked citations'],
  plan: ['Plan first', 'Review a plan before SideKick changes project files']
}

/**
 * The desktop's message box, laid out for a thumb: one row of controls, with attachments,
 * Plan and Research in a sheet from the + button and the model in its own. While SideKick
 * works, Send queues the message behind the run, as on the desktop; each queued message can
 * steer the run now, and Send with an empty box steers with the first.
 */
export function PhoneComposer({
  connection,
  runActive,
  sending,
  stopping,
  queue,
  models,
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

  const modelId = chosenModelId ?? models?.selectedModelId ?? null
  const model = models?.models.find((candidate) => candidate.id === modelId) ?? null
  const visionUnavailable = model?.supportsVision === false
  const hasContent = Boolean(text.trim() || files.attachments.length)
  // As on the desktop: an empty Send while SideKick works steers with the first queued message.
  const steerFirst = runActive && !hasContent && queue.queued.length > 0

  const submit = async (): Promise<void> => {
    if (steerFirst) {
      onSteerQueued(queue.queued[0].id)
      return
    }
    if (!hasContent || sending || files.uploading) return
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

  const insertDictation = (words: string): void => {
    const field = inputRef.current
    const start = field?.selectionStart ?? text.length
    const end = field?.selectionEnd ?? text.length
    const next = insertAtCursor(text, start, end, words)
    setText(next.value)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(next.cursor, next.cursor)
    })
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

  const contextBar =
    mode !== 'conversation' ? (
      <div
        className={`${mode === 'plan' ? 'plan-mode-bar' : 'research-mode-bar'} is-selected`}
        role="status"
      >
        <span className={mode === 'plan' ? 'plan-mode-icon' : 'research-mode-icon'} aria-hidden>
          {mode === 'plan' ? <ListChecks size={14} /> : <Microscope size={14} />}
        </span>
        <span className={mode === 'plan' ? 'plan-mode-copy' : 'research-mode-copy'}>
          <strong>{MODE_COPY[mode][0]}</strong>
          <span>{MODE_COPY[mode][1]}</span>
        </span>
        <button
          type="button"
          className="research-mode-remove"
          onClick={() => setMode('conversation')}
          title="Use normal conversation mode"
          aria-label={mode === 'plan' ? 'Remove Plan mode' : 'Remove research mode'}
        >
          <X size={13} />
        </button>
      </div>
    ) : undefined

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
          mode === 'research'
            ? 'What should SideKick research?'
            : mode === 'plan'
              ? 'What should SideKick plan?'
              : runActive
                ? 'Queue a message for SideKick'
                : 'Message SideKick'
        }
        queueTray={queueTray}
        attachmentTray={attachmentTray}
        contextBar={contextBar}
        onChange={setText}
        onKeyDown={(event) => {
          // Enter makes a new line on a phone keyboard; a hardware keyboard sends with Ctrl+Enter.
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            void submit()
          }
        }}
        onSend={() => void submit()}
        sendDisabled={(!hasContent && !steerFirst) || sending || files.uploading}
        sendTitle={
          steerFirst
            ? 'Steer with the first queued message'
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
          <>
            <button
              type="button"
              className={`input-plus-button ${sheet === 'add' ? 'menu-open' : ''}`}
              onClick={() => setSheet('add')}
              title="Add an attachment or agent behavior"
              aria-label="Add an attachment or agent behavior"
              aria-haspopup="dialog"
            >
              <Plus size={18} strokeWidth={1.8} />
            </button>
            {models && models.models.length > 0 && (
              <button
                type="button"
                className="cp-model-chip"
                onClick={() => setSheet('model')}
                title="Choose the model"
                aria-haspopup="dialog"
              >
                <Sparkles size={13} aria-hidden="true" />
                <span>{model?.name ?? 'Choose model'}</span>
                <ChevronDown size={13} aria-hidden="true" />
              </button>
            )}
          </>
        }
        toolbarRight={
          <>
            {voice?.dictation && (
              <PhoneDictation connection={connection} onText={insertDictation} />
            )}
            {runActive && (
              <button
                type="button"
                className={`stop-button ${stopping ? 'is-stopping' : ''}`}
                onClick={onStop}
                disabled={stopping}
                title={stopping ? 'Stopping...' : 'Stop generation'}
                aria-label={stopping ? 'Stopping' : 'Stop generation'}
              >
                <Square size={14} fill="currentColor" />
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
          <SheetSection label="Add">
            <SheetAction
              icon={<ImagePlus size={18} />}
              label="Photo library"
              description={imageReason ?? 'Attach up to four photos or screenshots'}
              disabled={Boolean(imageReason)}
              onClick={() => pick(libraryInput)}
            />
            <SheetAction
              icon={<Camera size={18} />}
              label="Take photo"
              description={imageReason ?? 'Use the camera'}
              disabled={Boolean(imageReason)}
              onClick={() => pick(cameraInput)}
            />
            <SheetAction
              icon={<FileText size={18} />}
              label="File"
              description="A text or code file, up to 2 MB"
              onClick={() => pick(fileInput)}
            />
          </SheetSection>
          <SheetSection label="Agent behavior">
            <SheetAction
              icon={<ListChecks size={18} />}
              label="Plan first"
              description="Review a plan before SideKick changes project files"
              selected={mode === 'plan'}
              onClick={() => {
                setMode((current) => (current === 'plan' ? 'conversation' : 'plan'))
                setSheet(null)
              }}
            />
            <SheetAction
              icon={<Microscope size={18} />}
              label="Research report"
              description="Search, cross-check, and cite web sources"
              selected={mode === 'research'}
              onClick={() => {
                setMode((current) => (current === 'research' ? 'conversation' : 'research'))
                setSheet(null)
              }}
            />
          </SheetSection>
        </Sheet>
      )}
      {sheet === 'model' && models && (
        <Sheet label="Choose the model" onClose={closeSheet}>
          <SheetSection label="Model for this chat">
            {models.models.map((candidate) => (
              <SheetAction
                key={candidate.id}
                icon={candidate.supportsVision ? <Eye size={18} /> : <Sparkles size={18} />}
                label={candidate.name}
                description={candidate.supportsVision ? 'Sees images' : undefined}
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
