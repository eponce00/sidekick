import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import {
  historyRestoreTargets,
  parseHistoryPoints,
  type HistoryRestoreTarget
} from '../../../shared/workspaceHistory'
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
  COMPANION_DICTATION_PIECE_SAMPLES,
  COMPANION_MAX_MESSAGES,
  COMPANION_MAX_MESSAGE_LENGTH,
  type CompanionCallName,
  type CompanionCalls,
  type CompanionChat,
  type CompanionChatDetail,
  type CompanionEvent,
  type CompanionImage,
  type CompanionMessage,
  type CompanionProject,
  type CompanionVoiceState
} from '../../../shared/companion'
import { createFallbackConversationTitle } from '../../../shared/conversationTitles'
import {
  isBrowserAnnotationAttachment,
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
import type { ProviderKind } from '../../../shared/providerRegistry'
import {
  reasoningOptions,
  resolveReasoningLevel,
  type ReasoningLevel,
  type ReasoningModel,
  type ReasoningSettings
} from '../../../shared/reasoning'
import {
  AGENT_PERMISSION_DECISIONS,
  type AgentPermissionDecision
} from '../../../shared/permissions'
import { renameConversation, setConversationPinned } from '../conversationActions'
import { ConversationCompactionStore } from '../conversationCompactionStore'
import { createConversation } from '../conversationCreation'
import { ProjectStore } from '../projectStore'
import { PromptAdmissionStore } from '../promptAdmissionStore'
import { CompanionUploads } from './companionUploads'

/** The computer's voice, as the phone's buttons use it. */
export interface CompanionVoice {
  state: () => CompanionVoiceState
  /** Live dictation: `onText` gets drafts of the phrase being spoken, then each phrase final. */
  startDictation: (
    dictationId: string,
    onText: (text: string, final: boolean) => void
  ) => Promise<{ ok: boolean; message?: string }>
  /** 16 kHz mono samples, in order. */
  pushDictation: (dictationId: string, samples: Float32Array) => void
  /** Resolves once everything heard so far is written. */
  stopDictation: (dictationId: string) => Promise<void>
  cancelDictation: (dictationId: string) => void
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
  /** The stored reasoning choices, which the window's slider and every run read. */
  reasoningSettings: () => ReasoningSettings
  /** Saves how hard a model thinks, as the window's slider does, and tells the window. */
  setReasoningLevel: (modelId: string, level: ReasoningLevel) => void
  /** Records the model a chat keeps, as choosing one in the window does. */
  setChatModel: (conversationId: string, modelId: string) => void
  /** A chat's saved messages changed outside the window, which should load them again. */
  messagesChanged: (conversationId: string) => void
  /** A chat's later messages were taken out to answer again; what its replies read is forgotten. */
  historyRewound: (conversationId: string) => void
  /** A chat's queued messages changed, for the window's composer and every phone. */
  queueChanged: (conversationId: string) => void
  /** A reduced copy of an image for a phone screen. */
  shrinkImage: (image: MessageImageAttachment) => Promise<CompanionImage>
  /** An image a tool result names by its `sidekick-browser://artifact/` address. */
  readArtifact: (url: string) => Promise<{ data: Buffer; contentType: string } | null>
  voice?: () => CompanionVoice | null
  /** Whether a project's folder is in a Git repository, so its chats can work in worktrees. */
  canUseWorktree: (projectId: string) => Promise<boolean>
  /** Moves a chat into its own worktree of its project, as the window's Work in does. */
  createWorktree: (conversationId: string) => Promise<void>
  /**
   * Puts a chat's folders back to History points together, as the window's Retry and Edit do.
   * Permission settings decide whether the computer asks.
   */
  restoreFiles: (targets: HistoryRestoreTarget[]) => Promise<void>
  /** A chat's place in the lists changed, or it is gone; the window and the phones list it again. */
  chatChanged: (conversationId: string, removed: boolean) => void
  /** Archives a chat as the window's Chats tab does; it refuses one that is working. */
  archiveChat: (conversationId: string) => void
  /** Deletes a chat as the window does, with its worktree when it was the last chat in it. */
  deleteChat: (conversationId: string) => Promise<void>
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
/** A phone streams its microphone without pause; this long without audio means it went away. */
const DICTATION_IDLE_MS = 15_000
const MAX_DICTATIONS_PER_PHONE = 2
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
  project_id: string | null
  worktree_id: string | null
  home_project_name: string | null
  project_name: string | null
}

const CHAT_COLUMNS = `c.id, c.title, c.updated_at, c.is_pinned, c.project_id, c.worktree_id,
  c.home_project_name, p.name AS project_name`

/** A saved message as Retry and Edit read it. */
interface HistoryRow {
  id: string
  role: string
  content: string
  timestamp: number
  run_mode: ConversationRunMode | null
  starts_goal: number | null
  checkpoints: string | null
}

/** A phone's live dictation; the voice service knows it by an ID of its own. */
interface Dictation {
  deviceId: string
  dictationId: string
  serviceId: string
  samples: number
  idle: ReturnType<typeof setTimeout> | null
}

/** A pinned model as the reasoning rules read it, as the window's chat reads it. */
function reasoningModelFor(model: PinnedModel): ReasoningModel {
  return {
    id: model.id,
    providerKind: model.providerKind ?? (model.provider as ProviderKind),
    model: model.providerModelId || model.id,
    supportsReasoning: model.supportsReasoning,
    reasoningLevels: model.reasoningLevels,
    reasoningDefault: model.reasoningDefault
  }
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
  /** Live dictations by phone and the phone's ID for them, so a phone reaches only its own. */
  private readonly dictations = new Map<string, Dictation>()

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
      case 'projects.list':
        return this.projects()
      case 'chat.retry':
        return this.retry(input)
      case 'chat.pin':
      case 'chat.rename':
      case 'chat.move':
      case 'chat.archive':
      case 'chat.delete':
        return this.changeChat(call, input)
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
      case 'models.setEffort':
        return this.setEffort(input)
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
      case 'voice.dictation.start':
        return this.startDictation(input, deviceId)
      case 'voice.dictation.audio':
        return this.dictationAudio(input, deviceId)
      case 'voice.dictation.stop':
        await this.finishDictation(deviceId, this.dictationId(input.dictationId))
        return { stopped: true }
      case 'voice.dictation.cancel':
        this.cancelDictation(`${deviceId}/${this.dictationId(input.dictationId)}`)
        return { cancelled: true }
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
      projectId: row.project_id,
      projectName: row.project_name ?? row.home_project_name ?? null,
      inWorktree: Boolean(row.worktree_id),
      activePhase: active,
      needsAnswer: Boolean(active && WAITING_PHASES.has(active))
    }
  }

  private chatRow(conversationId: string): ConversationRow {
    const row = this.deps.db
      .prepare(
        `SELECT ${CHAT_COLUMNS}
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
        `SELECT ${CHAT_COLUMNS}
         FROM conversations c LEFT JOIN projects p ON p.id = c.project_id
         WHERE c.archived_at IS NULL
         ORDER BY c.is_pinned DESC, c.updated_at DESC
         LIMIT ?`
      )
      .all(MAX_CHATS) as ConversationRow[]
    return rows.map((row) => this.chatFrom(row))
  }

  /** The projects in the desktop sidebar's order. */
  async projects(): Promise<CompanionProject[]> {
    const projects = new ProjectStore(this.deps.db).list().slice(0, MAX_CHATS)
    return Promise.all(
      projects.map(async (project) => ({
        id: project.id,
        name: project.name,
        canUseWorktree: await this.deps.canUseWorktree(project.id).catch(() => false)
      }))
    )
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
        const attachments = parseMessageContextAttachments(row.attachments)
        // The pictures of marked browser places show after the message's own images, as on the desktop.
        const markPictures = attachments.filter(isBrowserAnnotationAttachment).flatMap((mark) =>
          mark.image
            ? [
                {
                  id: mark.id,
                  name: `Mark ${mark.number}: ${mark.name}`,
                  mimeType: mark.image.mimeType,
                  dataUrl: mark.image.dataUrl
                }
              ]
            : []
        )
        const images = await Promise.all(
          [...parseMessageImages(row.images), ...markPictures].map((image) =>
            this.deps.shrinkImage(image).catch(() => null)
          )
        )
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
                attachments: attachments.map((attachment) => {
                  if (!isBrowserAnnotationAttachment(attachment)) {
                    const { id, kind, name } = attachment
                    return { id, kind, name }
                  }
                  // Its picture is among the message's images.
                  const { image: _picture, ...mark } = attachment
                  return mark
                })
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
      models: this.deps.models().map((model) => {
        const target = reasoningModelFor(model)
        const options = reasoningOptions(target)
        const level = options ? resolveReasoningLevel(target, this.deps.reasoningSettings()) : null
        return {
          id: model.id,
          name: model.name,
          supportsVision: model.supportsVision !== false,
          reasoning: options && level ? { ...options, level } : null
        }
      }),
      selectedModelId: this.deps.resolveModel(conversationId)?.id ?? null
    }
  }

  private setEffort(input: Record<string, unknown>): { level: ReasoningLevel } {
    const model = this.deps.models().find((candidate) => candidate.id === input.modelId)
    if (!model) throw new Error('That model is no longer available')
    const options = reasoningOptions(reasoningModelFor(model))
    const level = input.level as ReasoningLevel
    if (!options?.levels.includes(level)) throw new Error('This model does not offer that level')
    this.deps.setReasoningLevel(model.id, level)
    return { level }
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
    let worktree = false
    if (input.conversationId === undefined) {
      const projectId = input.projectId === undefined ? null : requireId(input.projectId, 'project')
      if (projectId && !new ProjectStore(this.deps.db).get(projectId))
        throw new Error('That project no longer exists')
      worktree = input.workIn === 'worktree'
      if (worktree && !projectId) throw new Error('A worktree belongs to a project; choose one')
      const model = this.deps.resolveModel('', requestedModel)
      const title = typeof input.text === 'string' && input.text.trim() ? input.text : 'New chat'
      conversationId = createConversation(this.deps.db, {
        title: createFallbackConversationTitle(title),
        projectId,
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
    if (worktree) {
      try {
        await this.deps.createWorktree(conversationId)
      } catch (error) {
        this.deps.db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
        throw new Error(
          `The worktree could not be made: ${error instanceof Error ? error.message : String(error)}`
        )
      }
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

  /** The chat menu's actions, each through the path the window's own uses. */
  private async changeChat(
    call: CompanionCallName,
    input: Record<string, unknown>
  ): Promise<unknown> {
    const conversationId = this.chatRow(requireId(input.conversationId, 'chat')).id
    const latest = this.deps.latestRun(conversationId)
    const working = Boolean(latest && ACTIVE_PHASES.has(latest.phase))
    switch (call) {
      case 'chat.pin': {
        if (typeof input.pinned !== 'boolean') throw new Error('Invalid pin')
        setConversationPinned(this.deps.db, conversationId, input.pinned)
        this.deps.chatChanged(conversationId, false)
        return { pinned: input.pinned }
      }
      case 'chat.rename': {
        const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : ''
        if (!title) throw new Error('Give the chat a name')
        if (title.length > 200) throw new Error('That name is too long')
        renameConversation(this.deps.db, conversationId, title, this.now())
        this.deps.chatChanged(conversationId, false)
        return { title }
      }
      case 'chat.move': {
        const projectId = input.projectId === null ? null : requireId(input.projectId, 'project')
        new ProjectStore(this.deps.db).moveConversation({ conversationId, projectId })
        this.deps.chatChanged(conversationId, false)
        return { projectId }
      }
      case 'chat.archive':
        this.deps.archiveChat(conversationId)
        this.deps.chatChanged(conversationId, true)
        return { archived: true }
      case 'chat.delete':
        if (working) throw new Error('SideKick is working in this chat. Stop it first.')
        await this.deps.deleteChat(conversationId)
        this.deps.chatChanged(conversationId, true)
        return { deleted: true }
      default:
        throw new Error('Unknown request')
    }
  }

  /**
   * Retry and Edit, as the window does them (`useConversationActions`): the files go back to
   * before the message, the replies after it are deleted, and the chat answers it again.
   */
  private async retry(input: Record<string, unknown>): Promise<{ runId: string }> {
    const conversationId = this.chatRow(requireId(input.conversationId, 'chat')).id
    const latest = this.deps.latestRun(conversationId)
    if (latest && ACTIVE_PHASES.has(latest.phase))
      throw new Error('SideKick is still working in this chat. Stop it first.')
    const rows = this.deps.db
      .prepare(
        `SELECT id, role, content, timestamp, run_mode, starts_goal, checkpoints
         FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC`
      )
      .all(conversationId) as HistoryRow[]
    let index = rows.findIndex((row) => row.id === input.messageId)
    if (index < 0) throw new Error('That message is no longer in the chat')
    // A reply is answered again from the message it answered.
    while (index >= 0 && rows[index].role !== 'user') index--
    if (index < 0) throw new Error('There is no message before this reply to answer again')
    const target = rows[index]
    // A goal is chat state the window restarts or ends with its first message; the phone leaves it.
    if (rows.slice(index).some((row) => row.starts_goal === 1))
      throw new Error('This changes a goal. Retry it on the computer.')
    let text: string | null = null
    if (input.text !== undefined) {
      text = typeof input.text === 'string' ? input.text.trim() : ''
      if (!text) throw new Error('Write the message first')
      if (text.length > COMPANION_MAX_MESSAGE_LENGTH) throw new Error('That message is too long')
    }
    const model = this.deps.resolveModel(conversationId)
    if (!model) throw new Error('This chat has no model. Choose one first.')

    await this.restoreFilesBefore(conversationId, rows, index)
    const compactions = new ConversationCompactionStore(this.deps.db)
    this.deps.db.transaction(() => {
      if (text !== null) {
        this.deps.db
          .prepare('UPDATE messages SET content = ? WHERE id = ? AND conversation_id = ?')
          .run(text, target.id, conversationId)
        compactions.invalidateFromTimestamp(conversationId, target.timestamp)
      }
      this.deps.db
        .prepare('DELETE FROM messages WHERE conversation_id = ? AND timestamp > ?')
        .run(conversationId, target.timestamp)
      compactions.invalidateAfterTimestamp(conversationId, target.timestamp)
      this.deps.db
        .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(this.now(), conversationId)
    })()
    this.deps.historyRewound(conversationId)
    this.deps.messagesChanged(conversationId)
    const runId = randomUUID()
    await this.deps.startRun({
      id: runId,
      conversationId,
      assistantMessageId: randomUUID(),
      model,
      mode: target.run_mode ?? 'conversation'
    })
    return { runId }
  }

  /**
   * The chat's folders as they were before the message at `index`: each back to its last earlier
   * History point, or, with none, to before the first one after it.
   */
  private async restoreFilesBefore(
    conversationId: string,
    rows: HistoryRow[],
    index: number
  ): Promise<void> {
    const project = new ProjectStore(this.deps.db).getConversationContext(conversationId)
    if (!project.workspaceRoot) return
    const targets = historyRestoreTargets(
      rows.map((row) => ({ checkpoints: parseHistoryPoints(row.checkpoints) })),
      index,
      [project.workspaceRoot, ...project.folders.map(({ path }) => path)]
    )
    if (!targets.length) return
    try {
      await this.deps.restoreFiles(targets)
    } catch (error) {
      // As in the window: the chat is answered again even when its files could not go back.
      console.warn('[Companion] Files could not be put back:', error)
    }
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

  private dictationId(value: unknown): string {
    const dictationId = requireId(value, 'dictation')
    if (!/^[\w-]{1,80}$/.test(dictationId)) throw new Error('Invalid dictation')
    return dictationId
  }

  private async startDictation(
    input: Record<string, unknown>,
    deviceId: string
  ): Promise<{ ok: boolean; message?: string }> {
    const voice = this.voice()
    if (!voice?.state().dictation)
      return {
        ok: false,
        message: voice?.state().message ?? 'Dictation is not available on this computer.'
      }
    const dictationId = this.dictationId(input.dictationId)
    const key = `${deviceId}/${dictationId}`
    if (this.dictations.has(key)) throw new Error('That dictation already started')
    const own = [...this.dictations.entries()].filter(([, item]) => item.deviceId === deviceId)
    while (own.length >= MAX_DICTATIONS_PER_PHONE) this.cancelDictation(own.shift()![0])
    const dictation: Dictation = {
      deviceId,
      dictationId,
      serviceId: `phone-${randomUUID()}`,
      samples: 0,
      idle: null
    }
    this.dictations.set(key, dictation)
    const started = await voice.startDictation(dictation.serviceId, (text, final) =>
      this.deps.sendToDevice(deviceId, { type: 'dictation.text', dictationId, text, final })
    )
    // Cancelled while it started.
    if (this.dictations.get(key) !== dictation) {
      if (started.ok) voice.cancelDictation(dictation.serviceId)
      return { ok: false, message: 'Dictation was stopped.' }
    }
    if (!started.ok) {
      this.dictations.delete(key)
      return { ok: false, message: started.message }
    }
    this.keepDictation(key, dictation)
    return { ok: true }
  }

  private dictationAudio(input: Record<string, unknown>, deviceId: string): { accepted: boolean } {
    const key = `${deviceId}/${this.dictationId(input.dictationId)}`
    const dictation = this.dictations.get(key)
    const voice = this.voice()
    // A dictation that ended (stopped, or idle too long) takes no more audio.
    if (!dictation || !voice) return { accepted: false }
    const pcm = typeof input.pcm === 'string' ? input.pcm : ''
    const bytes =
      pcm.length <= Math.ceil((COMPANION_DICTATION_PIECE_SAMPLES * 2) / 3) * 4
        ? Buffer.from(pcm, 'base64')
        : null
    if (!bytes?.length || bytes.length % 2 || bytes.length / 2 > COMPANION_DICTATION_PIECE_SAMPLES)
      throw new Error('That audio could not be read')
    const samples = new Float32Array(bytes.length / 2)
    for (let index = 0; index < samples.length; index++)
      samples[index] = bytes.readInt16LE(index * 2) / 0x8000
    dictation.samples += samples.length
    if (dictation.samples > MAX_DICTATION_SAMPLES) {
      void this.finishDictation(deviceId, dictation.dictationId)
      return { accepted: false }
    }
    voice.pushDictation(dictation.serviceId, samples)
    this.keepDictation(key, dictation)
    return { accepted: true }
  }

  /** Writes what was heard, then tells the phone its last words were sent. */
  private async finishDictation(deviceId: string, dictationId: string): Promise<void> {
    const key = `${deviceId}/${dictationId}`
    const dictation = this.dictations.get(key)
    if (dictation) {
      this.dictations.delete(key)
      if (dictation.idle) clearTimeout(dictation.idle)
      await this.voice()
        ?.stopDictation(dictation.serviceId)
        .catch(() => undefined)
    }
    this.deps.sendToDevice(deviceId, { type: 'dictation.end', dictationId })
  }

  private cancelDictation(key: string): void {
    const dictation = this.dictations.get(key)
    if (!dictation) return
    this.dictations.delete(key)
    if (dictation.idle) clearTimeout(dictation.idle)
    this.voice()?.cancelDictation(dictation.serviceId)
  }

  private keepDictation(key: string, dictation: Dictation): void {
    if (dictation.idle) clearTimeout(dictation.idle)
    dictation.idle = setTimeout(() => {
      if (this.dictations.get(key) === dictation)
        void this.finishDictation(dictation.deviceId, dictation.dictationId)
    }, DICTATION_IDLE_MS)
    dictation.idle.unref?.()
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
      // This card acts on the computer itself: it starts chats in its folders.
      if (intent === 'start_sessions') throw new Error('Answer this on the computer.')
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

  /** Forgets uploads, speech and dictation, as when phone access is turned off. */
  reset(): void {
    this.uploads.clear()
    for (const key of [...this.dictations.keys()]) this.cancelDictation(key)
    for (const speechId of this.speeches.keys()) this.voice()?.stop(speechId)
    this.speeches.clear()
  }
}
