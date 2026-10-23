import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type {
  AgentRunEventsResult,
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
  type CompanionMessage
} from '../../../shared/companion'
import { createFallbackConversationTitle } from '../../../shared/conversationTitles'
import type { PinnedModel } from '../../../shared/models'
import {
  AGENT_PERMISSION_DECISIONS,
  type AgentPermissionDecision
} from '../../../shared/permissions'
import { createConversation } from '../conversationCreation'

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
  /** Hands a message to the chat's running run; false when it cannot take one now. */
  steer: (
    conversationId: string,
    message: { id: string; content: string },
    onApplied: () => void
  ) => boolean
  resolveModel: (conversationId: string) => PinnedModel | null
  /** A chat's saved messages changed outside the window, which should load them again. */
  messagesChanged: (conversationId: string) => void
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

/**
 * A copy small enough for a phone: long text is cut, and images, which can be megabytes each,
 * are left out. The phone shows a summary of tools, so their full output is not needed there.
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

/** The calls a paired phone can make. Every input is checked here; the phone is not trusted. */
export class CompanionApi {
  private readonly now: () => number
  /** Messages handed to a run that has not taken them in yet, by run. */
  private readonly unapplied = new Map<
    string,
    Map<string, { conversationId: string; content: string }>
  >()

  constructor(private readonly deps: CompanionApiDependencies) {
    this.now = deps.now ?? Date.now
  }

  async handle(call: CompanionCallName, rawInput: unknown): Promise<unknown> {
    const input = record(rawInput)
    switch (call) {
      case 'chats.list':
        return this.chats()
      case 'chat.open':
        return this.open(requireId(input.conversationId, 'chat'))
      case 'chat.send':
        return this.send(input)
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
      default:
        throw new Error('Unknown request')
    }
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
        `SELECT id, role, content, segments, images, run_id, timestamp FROM messages
         WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?`
      )
      .all(conversationId, COMPANION_MAX_MESSAGES) as Array<{
      id: string
      role: string
      content: string | null
      segments: string | null
      images: string | null
      run_id: string | null
      timestamp: number
    }>
    const messages: CompanionMessage[] = rows.reverse().map((row) => {
      const parse = (text: string | null): unknown => {
        try {
          return text ? JSON.parse(text) : undefined
        } catch {
          return undefined
        }
      }
      const segments = parse(row.segments)
      const images = parse(row.images)
      return {
        id: row.id,
        // The desktop saves replies as `agent`; the phone's contract calls them `assistant`.
        role: row.role === 'agent' ? 'assistant' : row.role,
        content: trimForPhone(row.content ?? '') as string,
        timestamp: row.timestamp,
        ...(row.run_id ? { runId: row.run_id } : {}),
        ...(Array.isArray(segments) ? { segments: trimForPhone(segments) as unknown[] } : {}),
        ...(Array.isArray(images) && images.length ? { imageCount: images.length } : {})
      }
    })
    const latest = this.deps.latestRun(conversationId)
    let run: CompanionChatDetail['run'] = null
    if (latest && ACTIVE_PHASES.has(latest.phase)) {
      const result = await this.deps.runEvents(latest.id, 0)
      if (result.run)
        run = { run: result.run, events: trimForPhone(result.events) as AgentRunEvent[] }
    }
    return { chat, messages, run }
  }

  private async send(
    input: Record<string, unknown>
  ): Promise<CompanionCalls['chat.send']['output']> {
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (!text) throw new Error('Write a message first')
    if (text.length > COMPANION_MAX_MESSAGE_LENGTH) throw new Error('That message is too long')
    let conversationId: string
    if (input.conversationId === undefined) {
      const defaultModel = this.deps.resolveModel('')
      conversationId = createConversation(this.deps.db, {
        title: createFallbackConversationTitle(text),
        projectId: null,
        titleSource: 'fallback',
        modelId: defaultModel?.id ?? null
      }).id
    } else {
      conversationId = this.chatRow(requireId(input.conversationId, 'chat')).id
    }
    const latest = this.deps.latestRun(conversationId)
    if (latest && ACTIVE_PHASES.has(latest.phase)) {
      // The run takes the message at its next step, as one steered in from the composer would.
      const id = randomUUID()
      const waiting = this.unapplied.get(latest.id) ?? new Map()
      waiting.set(id, { conversationId, content: text })
      if (this.deps.steer(conversationId, { id, content: text }, () => waiting.delete(id))) {
        this.unapplied.set(latest.id, waiting)
        return { conversationId, runId: latest.id, steered: true }
      }
      waiting.delete(id)
      throw new Error(
        'SideKick cannot take a message right now. Answer its question or stop it, then send again.'
      )
    }
    const model = this.deps.resolveModel(conversationId)
    if (!model) throw new Error('This chat has no model. Choose one on the computer first.')
    this.saveUserMessage(conversationId, text)
    this.deps.messagesChanged(conversationId)
    const runId = randomUUID()
    await this.deps.startRun({
      id: runId,
      conversationId,
      assistantMessageId: randomUUID(),
      model,
      mode: 'conversation'
    })
    return { conversationId, runId, steered: false }
  }

  /**
   * A run ended. A message the phone handed it that it never took in, because it stopped first,
   * is saved to the chat, so it is not lost and the next run reads it.
   */
  runEnded(runId: string): void {
    const waiting = this.unapplied.get(runId)
    this.unapplied.delete(runId)
    if (!waiting?.size) return
    const changed = new Set<string>()
    for (const { conversationId, content } of waiting.values()) {
      this.saveUserMessage(conversationId, content)
      changed.add(conversationId)
    }
    for (const conversationId of changed) this.deps.messagesChanged(conversationId)
  }

  private saveUserMessage(conversationId: string, text: string): void {
    const timestamp = this.now()
    this.deps.db.transaction(() => {
      this.deps.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, role, content, run_mode, timestamp)
           VALUES (?, ?, 'user', ?, 'conversation', ?)`
        )
        .run(randomUUID(), conversationId, text, timestamp)
      this.deps.db
        .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(timestamp, conversationId)
    })()
  }

  /** A run of a chat, so a phone cannot reach runs that belong to nothing it can see. */
  private conversationRun(value: unknown): AgentRunSnapshot {
    const run = this.deps.run(requireId(value, 'run'))
    if (!run || run.surface !== 'conversation') throw new Error('That run no longer exists')
    this.chatRow(run.threadId)
    return run
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
}
