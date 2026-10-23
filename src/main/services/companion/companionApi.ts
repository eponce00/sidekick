import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type {
  AgentRunEventsResult,
  ConversationRunMode,
  PromptAdmissionItem,
  PromptAdmissionsResult,
  StartConversationAgentRunInput
} from '../../../shared/agentRunApi'
import type {
  AgentRunEvent,
  AgentRunPhase,
  AgentRunSnapshot,
  PendingAgentInteraction
} from '../../../shared/agentRuntime'
import {
  COMPANION_MAX_MESSAGES,
  COMPANION_MAX_MESSAGE_LENGTH,
  type CompanionCallName,
  type CompanionCalls,
  type CompanionChat,
  type CompanionChatDetail,
  type CompanionEvent,
  type CompanionImage,
  type CompanionMessage,
  type CompanionVoiceState
} from '../../../shared/companion'
import { createFallbackConversationTitle } from '../../../shared/conversationTitles'
import {
  parseMessageContextAttachments,
  pastedTextBudget,
  validateMessageContextAttachments,
  type MessageContextAttachment
} from '../../../shared/messageContextAttachments'
import {
  MAX_MESSAGE_IMAGES,
  parseMessageImages,
  validateMessageImages,
  type MessageImageAttachment
} from '../../../shared/messageImages'
import type { PinnedModel } from '../../../shared/models'
import {
  AGENT_PERMISSION_DECISIONS,
  type AgentPermissionDecision
} from '../../../shared/permissions'
import { createConversation } from '../conversationCreation'
import { PromptAdmissionStore } from '../promptAdmissionStore'
import { CompanionUploads } from './companionUploads'

/** The computer's voice, as the phone's buttons use it. */
export interface CompanionVoice {
  state: () => CompanionVoiceState
  /** The text in 16 kHz mono audio. */
  transcribe: (samples: Float32Array) => Promise<string>
  speak: (
    speechId: string,
    text: string,
    onAudio: (samples: Float32Array, sampleRate: number) => void,
    onEnd: (error?: string) => void
  ) => Promise<{ ok: boolean; message?: string }>
  stop: (speechId: string) => void
}

/** The runtime services a phone's calls go through: the same ones the desktop window uses. */
export interface CompanionApiDependencies {
  db: Database.Database
  startRun: (input: StartConversationAgentRunInput) => Promise<unknown>
  stopRun: (runId: string) => Promise<boolean>
  runEvents: (runId: string, afterSequence: number) => Promise<AgentRunEventsResult>
  latestRun: (conversationId: string) => AgentRunSnapshot | null
  run: (runId: string) => AgentRunSnapshot | null
  interaction: (id: string) => PendingAgentInteraction | null
  resolveInteraction: (input: {
    interactionId: string
    response: Record<string, unknown>
    cancelled?: boolean
  }) => Promise<unknown>
  /** Hands a stored queued message to the running run, as the composer's Steer does. */
  steerAdmission: (runId: string, admissionId: string) => boolean
  /** The models the user enabled. */
  models: () => PinnedModel[]
  /** The model a chat's next run uses: the one asked for, else the chat's own. */
  resolveModel: (conversationId: string, requestedId?: string) => PinnedModel | null
  /** Records the model a chat keeps, as choosing one in the window does. */
  setChatModel: (conversationId: string, modelId: string) => void
  /** A chat's saved messages changed outside the window, which should load them again. */
  messagesChanged: (conversationId: string) => void
  /** A chat's queued messages changed, for the window's composer and every phone. */
  queueChanged: (conversationId: string) => void
  /** A reduced copy of an image for a phone screen. */
  shrinkImage: (image: MessageImageAttachment) => Promise<CompanionImage>
  /** An image a tool result names by its `sidekick-browser://artifact/` address. */
  readArtifact: (url: string) => Promise<{ data: Buffer; contentType: string } | null>
  voice?: () => CompanionVoice | null
  /** An event for one phone only, such as its speech. */
  sendToDevice: (deviceId: string, event: CompanionEvent) => void
  /** Runs work after a delay; tests run it at once. */
  later?: (work: () => void, ms: number) => void
  now?: () => number
}

const ACTIVE_PHASES = new Set<AgentRunPhase>([
  'queued',
  'streaming',
  'awaiting_permission',
  'awaiting_user',
  'executing_tool',
  'compacting',
  'stopping'
])
const WAITING_PHASES = new Set<AgentRunPhase>(['awaiting_permission', 'awaiting_user'])
const MAX_TEXT = 4_000
const MAX_CHATS = 100
const MODES: readonly ConversationRunMode[] = ['conversation', 'research', 'plan']
/** A window that follows the chat takes its next queued message first; this one is the fallback. */
const DRAIN_DELAY_MS = 1_500
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024
/** Thirty minutes of dictation at 16 kHz. */
const MAX_DICTATION_SAMPLES = 16_000 * 60 * 30
const MAX_SPEECH_CHARACTERS = 60_000

/**
 * A copy small enough for a phone: long text is cut, and inline images, which can be megabytes
 * each, are left out. Images a tool saved are named by address and fetched with `media.get`.
 */
export function trimForPhone(value: unknown, depth = 0): unknown {
  if (typeof value === 'string')
    return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}… (shortened)` : value
  if (depth > 12) return null
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => trimForPhone(item, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === 'images' || key === 'screenshot' || key === 'dataUrl' || key === 'base64')
        continue
      if (typeof item === 'string' && item.startsWith('data:')) continue
      out[key] = trimForPhone(item, depth + 1)
    }
    return out
  }
  return value
}

/** 16-bit little-endian samples, base64, half the size of the floats speech is made of. */
export function pcm16Base64(samples: Float32Array): string {
  const out = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    out.writeInt16LE(Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), index * 2)
  }
  return out.toString('base64')
}

function requireId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value || value.length > 200) throw new Error(`Invalid ${what}`)
  return value
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

interface ConversationRow {
  id: string
  title: string
  updated_at: number
  is_pinned: number
  home_project_name: string | null
  project_name: string | null
}

/** What one message carries, ready to save or queue. */
interface PreparedMessage {
  content: string
  mode: ConversationRunMode
  images: MessageImageAttachment[]
  attachments: MessageContextAttachment[]
}

/** The calls a paired phone can make. Every input is checked here; the phone is not trusted. */
export class CompanionApi {
  private readonly now: () => number
  private readonly later: (work: () => void, ms: number) => void
  private readonly admissions: PromptAdmissionStore
  private readonly uploads: CompanionUploads
  /** Speech each phone started, so one phone cannot stop another's. */
  private readonly speeches = new Map<string, string>()

  constructor(private readonly deps: CompanionApiDependencies) {
    this.now = deps.now ?? Date.now
    this.later =
      deps.later ??
      ((work, ms) => {
        setTimeout(work, ms).unref?.()
      })
    this.admissions = new PromptAdmissionStore(deps.db)
    this.uploads = new CompanionUploads(this.now)
  }

  async handle(call: CompanionCallName, rawInput: unknown, deviceId: string): Promise<unknown> {
    const input = record(rawInput)
    switch (call) {
      case 'chats.list':
        return this.chats()
      case 'chat.open':
        return this.open(requireId(input.conversationId, 'chat'))
      case 'chat.send':
        return this.send(input, deviceId)
      case 'queue.list':
        return this.queueForPhone(this.chatRow(requireId(input.conversationId, 'chat')).id)
      case 'queue.update':
        return this.updateQueue(input)
      case 'queue.steer':
        return this.steerQueued(input)
      case 'models.list':
        return this.modelList(input)
      case 'run.stop':
        return { stopped: await this.deps.stopRun(this.conversationRun(input.runId).id) }
      case 'run.events': {
        const run = this.conversationRun(input.runId)
        const after = Number(input.afterSequence)
        const result = await this.deps.runEvents(run.id, Number.isFinite(after) ? after : 0)
        return trimForPhone(result) as CompanionCalls['run.events']['output']
      }
      case 'interaction.resolve':
        return this.resolve(input)
      case 'upload.put':
        return this.uploads.put(deviceId, {
          uploadId: input.uploadId,
          kind: input.kind,
          name: input.name,
          mimeType: input.mimeType,
          data: input.data,
          last: input.last
        })
      case 'media.get':
        return this.media(input)
      case 'voice.state':
        return this.voice()?.state() ?? { dictation: false, speech: false, message: null }
      case 'voice.transcribe':
        return this.transcribe(input, deviceId)
      case 'voice.speak':
        return this.speak(input, deviceId)
      case 'voice.stop': {
        const speechId = requireId(input.speechId, 'speech')
        if (this.speeches.get(speechId) === deviceId) this.voice()?.stop(speechId)
        return { stopped: true }
      }
      default:
        throw new Error('Unknown request')
    }
  }

  private voice(): CompanionVoice | null {
    return this.deps.voice?.() ?? null
  }

  private chatFrom(row: ConversationRow): CompanionChat {
    const run = this.deps.latestRun(row.id)
    const active = run && ACTIVE_PHASES.has(run.phase) ? run.phase : null
    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      pinned: row.is_pinned === 1,
      projectName: row.project_name ?? row.home_project_name ?? null,
      activePhase: active,
      needsAnswer: Boolean(active && WAITING_PHASES.has(active))
    }
  }

  private chatRow(conversationId: string): ConversationRow {
    const row = this.deps.db
      .prepare(
        `SELECT c.id, c.title, c.updated_at, c.is_pinned, c.home_project_name, p.name AS project_name
         FROM conversations c LEFT JOIN projects p ON p.id = c.project_id
         WHERE c.id = ? AND c.archived_at IS NULL`
      )
      .get(conversationId) as ConversationRow | undefined
    if (!row) throw new Error('That chat no longer exists')
    return row
  }

  chats(): CompanionChat[] {
    const rows = this.deps.db
      .prepare(
        `SELECT c.id, c.title, c.updated_at, c.is_pinned, c.home_project_name, p.name AS project_name
         FROM conversations c LEFT JOIN projects p ON p.id = c.project_id
         WHERE c.archived_at IS NULL
         ORDER BY c.is_pinned DESC, c.updated_at DESC
         LIMIT ?`
      )
      .all(MAX_CHATS) as ConversationRow[]
    return rows.map((row) => this.chatFrom(row))
  }

  async open(conversationId: string): Promise<CompanionChatDetail> {
    const chat = this.chatFrom(this.chatRow(conversationId))
    const rows = this.deps.db
      .prepare(
        `SELECT id, role, content, segments, images, attachments, token_usage, run_id, run_mode,
                timestamp
         FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?`
      )
      .all(conversationId, COMPANION_MAX_MESSAGES) as Array<{
      id: string
      role: string
      content: string | null
      segments: string | null
      images: string | null
      attachments: string | null
      token_usage: string | null
      run_id: string | null
      run_mode: string | null
      timestamp: number
    }>
    const messages: CompanionMessage[] = await Promise.all(
      rows.reverse().map(async (row) => {
        const parse = (text: string | null): unknown => {
          try {
            return text ? JSON.parse(text) : undefined
          } catch {
            return undefined
          }
        }
        const segments = parse(row.segments)
        const tokenUsage = parse(row.token_usage)
        const images = await Promise.all(
          parseMessageImages(row.images).map((image) =>
            this.deps.shrinkImage(image).catch(() => null)
          )
        )
        const attachments = parseMessageContextAttachments(row.attachments)
        return {
          id: row.id,
          // The desktop saves replies as `agent`; the phone's contract calls them `assistant`.
          role: row.role === 'agent' ? 'assistant' : row.role,
          content: trimForPhone(row.content ?? '') as string,
          timestamp: row.timestamp,
          ...(row.run_id ? { runId: row.run_id } : {}),
          ...(row.run_mode && MODES.includes(row.run_mode as ConversationRunMode)
            ? { runMode: row.run_mode as ConversationRunMode }
            : {}),
          ...(Array.isArray(segments) ? { segments: trimForPhone(segments) as unknown[] } : {}),
          ...(tokenUsage && typeof tokenUsage === 'object'
            ? { tokenUsage: tokenUsage as Record<string, unknown> }
            : {}),
          ...(images.some(Boolean)
            ? { images: images.filter((image): image is CompanionImage => image !== null) }
            : {}),
          ...(attachments.length
            ? {
                attachments: attachments.map(({ id, kind, name }) => ({ id, kind, name }))
              }
            : {})
        }
      })
    )
    const latest = this.deps.latestRun(conversationId)
    let run: CompanionChatDetail['run'] = null
    if (latest && ACTIVE_PHASES.has(latest.phase)) {
      const result = await this.deps.runEvents(latest.id, 0)
      if (result.run)
        run = { run: result.run, events: trimForPhone(result.events) as AgentRunEvent[] }
    }
    return { chat, messages, run }
  }

  private modelList(input: Record<string, unknown>): CompanionCalls['models.list']['output'] {
    const conversationId =
      input.conversationId === undefined
        ? ''
        : this.chatRow(requireId(input.conversationId, 'chat')).id
    return {
      models: this.deps.models().map((model) => ({
        id: model.id,
        name: model.name,
        supportsVision: model.supportsVision !== false
      })),
      selectedModelId: this.deps.resolveModel(conversationId)?.id ?? null
    }
  }

  /** The text, images and files one message from the phone carries, checked as the window checks them. */
  private prepare(
    input: Record<string, unknown>,
    deviceId: string,
    model: PinnedModel | null
  ): PreparedMessage {
    const content = typeof input.text === 'string' ? input.text.trim() : ''
    if (content.length > COMPANION_MAX_MESSAGE_LENGTH) throw new Error('That message is too long')
    const mode = input.mode === undefined ? 'conversation' : (input.mode as ConversationRunMode)
    if (!MODES.includes(mode)) throw new Error('Invalid mode')
    const imageRefs = Array.isArray(input.images) ? input.images : []
    const fileRefs = Array.isArray(input.files) ? input.files : []
    if (imageRefs.length > MAX_MESSAGE_IMAGES)
      throw new Error(`A message can contain up to ${MAX_MESSAGE_IMAGES} images`)
    if (imageRefs.length && model?.supportsVision === false)
      throw new Error("This chat's model cannot see images. Choose one that can, or remove them.")
    const images = validateMessageImages(
      imageRefs.map((ref) => {
        const upload = this.uploads.take(deviceId, record(ref).uploadId, 'image')
        return {
          id: upload.id,
          name: upload.name,
          mimeType: upload.mimeType,
          dataUrl: `data:${upload.mimeType};base64,${upload.data.toString('base64')}`
        }
      })
    )
    const budget = pastedTextBudget(model?.contextLength)
    const attachments = validateMessageContextAttachments(
      fileRefs.map((ref) => {
        const upload = this.uploads.take(deviceId, record(ref).uploadId, 'text')
        if (upload.data.length > MAX_TEXT_FILE_BYTES) throw new Error(`${upload.name} is too large`)
        const text = new TextDecoder('utf-8', { fatal: false }).decode(upload.data)
        // A text file has no NUL characters and few replacement characters; a binary one has both.
        if (text.includes('\u0000') || (text.match(/�/g)?.length ?? 0) > text.length / 100)
          throw new Error(`${upload.name} is not a text file. Attach images or text files.`)
        if (text.length > budget)
          throw new Error(`${upload.name} is too long for this chat's model`)
        return { id: upload.id, kind: 'text', name: upload.name, content: text, size: text.length }
      })
    )
    if (!content && !images.length && !attachments.length) throw new Error('Write a message first')
    return { content, mode, images, attachments }
  }

  private async send(
    input: Record<string, unknown>,
    deviceId: string
  ): Promise<CompanionCalls['chat.send']['output']> {
    const requestedModel =
      input.modelId === undefined ? undefined : requireId(input.modelId, 'model')
    let conversationId: string
    let created = false
    if (input.conversationId === undefined) {
      const model = this.deps.resolveModel('', requestedModel)
      const title = typeof input.text === 'string' && input.text.trim() ? input.text : 'New chat'
      conversationId = createConversation(this.deps.db, {
        title: createFallbackConversationTitle(title),
        projectId: null,
        titleSource: 'fallback',
        modelId: model?.id ?? null
      }).id
      created = true
    } else {
      conversationId = this.chatRow(requireId(input.conversationId, 'chat')).id
    }
    const model = this.deps.resolveModel(conversationId, requestedModel)
    if (requestedModel && !model) throw new Error('That model is no longer available')
    let message: PreparedMessage
    try {
      message = this.prepare(input, deviceId, model)
    } catch (error) {
      if (created)
        this.deps.db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
      throw error
    }
    if (requestedModel && model) this.deps.setChatModel(conversationId, model.id)
    const latest = this.deps.latestRun(conversationId)
    if (latest && ACTIVE_PHASES.has(latest.phase)) {
      const item = this.admission(conversationId, message)
      if (input.behavior === 'steer') {
        const steered = await this.steer(conversationId, latest.id, item)
        return { conversationId, runId: latest.id, steered, queued: !steered }
      }
      const current = this.admissions.list(conversationId)
      this.admissions.replace({
        conversationId,
        queued: [...current.queued, item],
        pivot: current.pivot
      })
      this.deps.queueChanged(conversationId)
      return { conversationId, runId: latest.id, steered: false, queued: true }
    }
    if (!model) throw new Error('This chat has no model. Choose one first.')
    const runId = await this.start(conversationId, message, model)
    return { conversationId, runId, steered: false, queued: false }
  }

  private admission(conversationId: string, message: PreparedMessage): PromptAdmissionItem {
    const now = this.now()
    return {
      id: randomUUID(),
      conversationId,
      content: message.content,
      ...(message.images.length ? { images: message.images } : {}),
      ...(message.attachments.length ? { attachments: message.attachments } : {}),
      mode: message.mode,
      behavior: 'queue',
      position: 0,
      createdAt: now,
      updatedAt: now
    }
  }

  /**
   * Hands a message to the running run now, as the composer's Steer does: it becomes the pending
   * steer (an earlier one moves to the front of the queue). A run that cannot take it, because it
   * waits on the user or is finishing, is stopped, and the message starts the next run.
   */
  private async steer(
    conversationId: string,
    runId: string,
    item: PromptAdmissionItem
  ): Promise<boolean> {
    const current = this.admissions.list(conversationId)
    const queued = current.queued.filter((queuedItem) => queuedItem.id !== item.id)
    this.admissions.replace({
      conversationId,
      queued: current.pivot ? [current.pivot, ...queued] : queued,
      pivot: item
    })
    this.deps.queueChanged(conversationId)
    if (this.deps.steerAdmission(runId, item.id)) return true
    await this.deps.stopRun(runId)
    return false
  }

  /** The queue with reduced images and pasted text cut, enough for the tray. */
  private async queueForPhone(conversationId: string): Promise<PromptAdmissionsResult> {
    const light = async (item: PromptAdmissionItem): Promise<PromptAdmissionItem> => ({
      ...item,
      ...(item.images?.length
        ? {
            images: await Promise.all(
              item.images.map((image) => this.deps.shrinkImage(image).catch(() => image))
            )
          }
        : {}),
      ...(item.attachments?.length
        ? { attachments: trimForPhone(item.attachments) as MessageContextAttachment[] }
        : {})
    })
    const current = this.admissions.list(conversationId)
    return {
      queued: await Promise.all(current.queued.map(light)),
      pivot: current.pivot ? await light(current.pivot) : null
    }
  }

  private updateQueue(input: Record<string, unknown>): PromptAdmissionsResult {
    const conversationId = this.chatRow(requireId(input.conversationId, 'chat')).id
    const current = this.admissions.list(conversationId)
    const byId = new Map(current.queued.map((item) => [item.id, item]))
    const wanted = Array.isArray(input.queued) ? input.queued.slice(0, 100) : []
    const queued = wanted.flatMap((raw) => {
      const entry = record(raw)
      const item = typeof entry.id === 'string' ? byId.get(entry.id) : undefined
      if (!item) return []
      byId.delete(item.id)
      const content = typeof entry.content === 'string' ? entry.content.trim() : item.content
      if (content.length > COMPANION_MAX_MESSAGE_LENGTH) throw new Error('That message is too long')
      return [{ ...item, content: content || item.content }]
    })
    const result = this.admissions.replace({ conversationId, queued, pivot: current.pivot })
    this.deps.queueChanged(conversationId)
    return result
  }

  private async steerQueued(input: Record<string, unknown>): Promise<{ steered: boolean }> {
    const conversationId = this.chatRow(requireId(input.conversationId, 'chat')).id
    const item = this.admissions
      .list(conversationId)
      .queued.find((queued) => queued.id === input.admissionId)
    if (!item) throw new Error('That message is no longer queued')
    const latest = this.deps.latestRun(conversationId)
    if (!latest || !ACTIVE_PHASES.has(latest.phase)) {
      // Nothing is running, so the message simply starts the next reply.
      this.drain(conversationId)
      return { steered: false }
    }
    return { steered: await this.steer(conversationId, latest.id, item) }
  }

  /** Saves the user's message and starts a run on the same path the window uses. */
  private async start(
    conversationId: string,
    message: PreparedMessage,
    model: PinnedModel
  ): Promise<string> {
    const timestamp = this.now()
    this.deps.db.transaction(() => {
      this.deps.db
        .prepare(
          `INSERT INTO messages
           (id, conversation_id, role, content, images, attachments, run_mode, timestamp)
           VALUES (?, ?, 'user', ?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          conversationId,
          message.content,
          message.images.length ? JSON.stringify(message.images) : null,
          message.attachments.length ? JSON.stringify(message.attachments) : null,
          message.mode,
          timestamp
        )
      this.deps.db
        .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(timestamp, conversationId)
    })()
    this.deps.messagesChanged(conversationId)
    const runId = randomUUID()
    await this.deps.startRun({
      id: runId,
      conversationId,
      assistantMessageId: randomUUID(),
      model,
      mode: message.mode
    })
    return runId
  }

  /**
   * A run of a chat ended. The window that follows a chat sends its next queued message itself; a
   * chat no window follows, such as one driven from the phone, gets it from here, as the window
   * would have sent it.
   */
  runEnded(conversationId: string): void {
    this.later(() => this.drain(conversationId), DRAIN_DELAY_MS)
  }

  private drain(conversationId: string): void {
    const latest = this.deps.latestRun(conversationId)
    if (latest && ACTIVE_PHASES.has(latest.phase)) return
    // Taking is atomic, so a window that drains at the same moment gets it instead, not both.
    const next = this.admissions.takeNext(conversationId)
    if (!next) return
    this.deps.queueChanged(conversationId)
    const model = this.deps.resolveModel(conversationId)
    if (!model) {
      // Put it back so it is not lost; the user chooses a model and sends again.
      const current = this.admissions.list(conversationId)
      this.admissions.replace({
        conversationId,
        queued: [next, ...current.queued],
        pivot: current.pivot
      })
      return
    }
    void this.start(
      conversationId,
      {
        content: next.content,
        mode: next.mode,
        images: next.images ?? [],
        attachments: next.attachments ?? []
      },
      model
    ).catch((error) => console.warn('[Companion] Could not send a queued message:', error))
  }

  /**
   * A run of a chat the phone can see: the chat's own runs, research runs and the sub-agents they
   * start all belong to it. Anything else is refused.
   */
  private conversationRun(value: unknown): AgentRunSnapshot {
    const run = this.deps.run(requireId(value, 'run'))
    if (!run) throw new Error('That run no longer exists')
    this.chatRow(run.threadId)
    return run
  }

  private async media(input: Record<string, unknown>): Promise<{ dataUrl: string }> {
    const url = typeof input.url === 'string' ? input.url.slice(0, 2_000) : ''
    const file = await this.deps.readArtifact(url)
    if (!file) throw new Error('That image is no longer available')
    return { dataUrl: `data:${file.contentType};base64,${file.data.toString('base64')}` }
  }

  private async transcribe(
    input: Record<string, unknown>,
    deviceId: string
  ): Promise<{ text: string }> {
    const voice = this.voice()
    if (!voice?.state().dictation)
      throw new Error(voice?.state().message ?? 'Dictation is not available on this computer')
    const upload = this.uploads.take(deviceId, input.uploadId, 'audio')
    if (upload.data.length % 4 || upload.data.length / 4 > MAX_DICTATION_SAMPLES)
      throw new Error('That recording could not be read')
    const samples = new Float32Array(upload.data.length / 4)
    for (let index = 0; index < samples.length; index++)
      samples[index] = upload.data.readFloatLE(index * 4)
    return { text: (await voice.transcribe(samples)).trim() }
  }

  private async speak(
    input: Record<string, unknown>,
    deviceId: string
  ): Promise<{ ok: boolean; message?: string }> {
    const voice = this.voice()
    if (!voice?.state().speech)
      return { ok: false, message: voice?.state().message ?? 'Read aloud is not available' }
    const speechId = requireId(input.speechId, 'speech')
    if (!/^[\w-]{1,80}$/.test(speechId)) throw new Error('Invalid speech')
    const text = typeof input.text === 'string' ? input.text.slice(0, MAX_SPEECH_CHARACTERS) : ''
    if (!text.trim()) throw new Error('Nothing to read')
    this.speeches.set(speechId, deviceId)
    return voice.speak(
      speechId,
      text,
      (samples, sampleRate) =>
        this.deps.sendToDevice(deviceId, {
          type: 'speech.audio',
          speechId,
          sampleRate,
          pcm: pcm16Base64(samples)
        }),
      (error) => {
        this.speeches.delete(speechId)
        this.deps.sendToDevice(deviceId, {
          type: 'speech.end',
          speechId,
          ...(error ? { error } : {})
        })
      }
    )
  }

  private async resolve(input: Record<string, unknown>): Promise<{ success: true }> {
    const interaction = this.deps.interaction(requireId(input.interactionId, 'card'))
    if (!interaction || interaction.status !== 'pending')
      throw new Error('That card was already answered')
    this.conversationRun(interaction.runId)
    const raw = record(input.response)
    const cancelled = input.cancelled === true
    let response: Record<string, unknown>
    if (interaction.kind === 'permission') {
      const decision = raw.decision as AgentPermissionDecision
      if (!AGENT_PERMISSION_DECISIONS.includes(decision)) throw new Error('Choose an answer')
      if (decision === 'allow_chat' && !interaction.request.chatScope)
        throw new Error('This request can only be allowed once')
      response = { approved: decision === 'allow_once' || decision === 'allow_chat', decision }
    } else if (interaction.kind === 'tool_limit') {
      if (typeof raw.approved !== 'boolean') throw new Error('Choose an answer')
      response = { approved: raw.approved }
    } else if (interaction.kind === 'plan_approval') {
      const action = raw.action
      const revision = typeof raw.revision === 'string' ? raw.revision.slice(0, 200) : undefined
      if (action === 'approve')
        response = { action, approved: true, ...(revision ? { revision } : {}) }
      else if (action === 'keep') response = { action, ...(revision ? { revision } : {}) }
      else if (action === 'revise') {
        const feedback = typeof raw.feedback === 'string' ? raw.feedback.trim() : ''
        if (!feedback || feedback.length > COMPANION_MAX_MESSAGE_LENGTH)
          throw new Error('Say what to change')
        response = { action, feedback, ...(revision ? { revision } : {}) }
      } else throw new Error('Choose an answer')
    } else if (interaction.kind === 'question') {
      const intent = interaction.request.intent
      // These cards act on the computer itself: starting chats in folders, or taking over its browser.
      if (intent === 'start_sessions' || intent === 'browser_takeover')
        throw new Error('Answer this on the computer.')
      const questions = Array.isArray(interaction.request.questions)
        ? (interaction.request.questions as Array<Record<string, unknown>>)
        : []
      const ids = new Set(questions.map((question) => String(question.id)))
      response = {}
      if (!cancelled)
        for (const [id, answer] of Object.entries(raw)) {
          if (!ids.has(id)) continue
          const values = (Array.isArray(answer) ? answer : [answer])
            .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
            .slice(0, 20)
            .map((value) => value.slice(0, 4_000))
          if (values.length) response[id] = Array.isArray(answer) ? values : values[0]
        }
    } else {
      throw new Error('Answer this on the computer.')
    }
    await this.deps.resolveInteraction({
      interactionId: interaction.id,
      response,
      ...(cancelled && interaction.kind === 'question' ? { cancelled: true } : {})
    })
    return { success: true }
  }

  /** Forgets uploads and speech, as when phone access is turned off. */
  reset(): void {
    this.uploads.clear()
    for (const speechId of this.speeches.keys()) this.voice()?.stop(speechId)
    this.speeches.clear()
  }
}
