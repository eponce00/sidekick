import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRunSnapshot, PendingAgentInteraction } from '../../../shared/agentRuntime'
import type { PinnedModel } from '../../../shared/models'
import { applyDatabaseSchema } from '../../bootstrap/database'
import { createConversation } from '../conversationCreation'
import { CompanionApi, trimForPhone, type CompanionApiDependencies } from './companionApi'

const MODEL = { id: 'local:model', name: 'model', provider: 'lmstudio' } as PinnedModel

function run(overrides: Partial<AgentRunSnapshot> = {}): AgentRunSnapshot {
  return {
    id: 'run-1',
    threadId: 'chat',
    surface: 'conversation',
    phase: 'streaming',
    ...overrides
  } as AgentRunSnapshot
}

function setup(overrides: Partial<CompanionApiDependencies> = {}) {
  const db = new Database(':memory:')
  applyDatabaseSchema(db)
  const chat = createConversation(db, {
    title: 'Fix the build',
    projectId: null,
    titleSource: 'fallback',
    modelId: null
  })
  const runs = new Map<string, AgentRunSnapshot>()
  const interactions = new Map<string, PendingAgentInteraction>()
  const deps: CompanionApiDependencies = {
    db,
    startRun: vi.fn(async () => undefined),
    stopRun: vi.fn(async () => true),
    runEvents: vi.fn(
      async (runId: string) => ({ run: runs.get(runId) ?? null, events: [] }) as never
    ),
    latestRun: vi.fn(
      (conversationId: string) =>
        [...runs.values()].find((item) => item.threadId === conversationId) ?? null
    ),
    run: vi.fn((runId: string) => runs.get(runId) ?? null),
    interaction: vi.fn((id: string) => interactions.get(id) ?? null),
    resolveInteraction: vi.fn(async () => undefined),
    steer: vi.fn(() => true),
    resolveModel: vi.fn(() => MODEL),
    messagesChanged: vi.fn(),
    ...overrides
  }
  return { api: new CompanionApi(deps), deps, db, chat, runs, interactions }
}

function interaction(overrides: Partial<PendingAgentInteraction>): PendingAgentInteraction {
  return {
    id: 'card',
    runId: 'run-1',
    kind: 'permission',
    status: 'pending',
    request: {},
    createdAt: 1,
    ...overrides
  }
}

describe('CompanionApi', () => {
  it('lists chats with whether each is working or waiting for an answer', async () => {
    const { api, chat, runs } = setup()
    runs.set('run-1', run({ threadId: chat.id, phase: 'awaiting_permission' }))
    expect(await api.handle('chats.list', {})).toEqual([
      expect.objectContaining({
        id: chat.id,
        title: 'Fix the build',
        activePhase: 'awaiting_permission',
        needsAnswer: true
      })
    ])
  })

  it('saves a message and starts a run on the same path the window uses', async () => {
    const { api, deps, db, chat } = setup()
    const result = await api.handle('chat.send', {
      conversationId: chat.id,
      text: '  Run the tests '
    })
    expect(result).toMatchObject({ conversationId: chat.id, steered: false })
    expect(db.prepare('SELECT role, content FROM messages').all()).toEqual([
      { role: 'user', content: 'Run the tests' }
    ])
    expect(deps.messagesChanged).toHaveBeenCalledWith(chat.id)
    expect(deps.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: chat.id, model: MODEL, mode: 'conversation' })
    )
  })

  it('hands a message to a running run instead of starting another', async () => {
    const { api, deps, db, chat, runs } = setup()
    runs.set('run-1', run({ threadId: chat.id }))
    expect(await api.handle('chat.send', { conversationId: chat.id, text: 'also lint' })).toEqual({
      conversationId: chat.id,
      runId: 'run-1',
      steered: true
    })
    expect(deps.steer).toHaveBeenCalledWith(
      chat.id,
      expect.objectContaining({ content: 'also lint' }),
      expect.any(Function)
    )
    expect(deps.startRun).not.toHaveBeenCalled()
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 })
    vi.mocked(deps.steer).mockReturnValue(false)
    await expect(api.handle('chat.send', { conversationId: chat.id, text: 'x' })).rejects.toThrow(
      /cannot take a message/
    )
  })

  it('saves a handed-in message the run never took, so stopping does not lose it', async () => {
    const { api, deps, db, chat, runs } = setup()
    runs.set('run-1', run({ threadId: chat.id }))
    let apply: (() => void) | undefined
    vi.mocked(deps.steer).mockImplementation((_chat, _message, onApplied) => {
      apply = onApplied
      return true
    })
    await api.handle('chat.send', { conversationId: chat.id, text: 'first' })
    apply?.()
    await api.handle('chat.send', { conversationId: chat.id, text: 'second' })
    api.runEnded('run-1')
    expect(db.prepare('SELECT role, content FROM messages').all()).toEqual([
      { role: 'user', content: 'second' }
    ])
    expect(deps.messagesChanged).toHaveBeenCalledWith(chat.id)
    api.runEnded('run-1')
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 })
  })

  it('starts a new chat when none is named', async () => {
    const { api, db } = setup()
    const result = (await api.handle('chat.send', { text: 'Plan a trip to Lisbon' })) as {
      conversationId: string
    }
    expect(
      db
        .prepare('SELECT title, model_id FROM conversations WHERE id = ?')
        .get(result.conversationId)
    ).toEqual({
      title: expect.stringContaining('Lisbon'),
      model_id: MODEL.id
    })
  })

  it('refuses empty or oversized messages, unknown chats, and chats without a model', async () => {
    const { api, chat } = setup({ resolveModel: vi.fn(() => null) })
    await expect(
      api.handle('chat.send', { conversationId: chat.id, text: '   ' })
    ).rejects.toThrow()
    await expect(
      api.handle('chat.send', { conversationId: chat.id, text: 'x'.repeat(100_001) })
    ).rejects.toThrow()
    await expect(api.handle('chat.send', { conversationId: 'nope', text: 'hi' })).rejects.toThrow(
      /no longer exists/
    )
    await expect(api.handle('chat.send', { conversationId: chat.id, text: 'hi' })).rejects.toThrow(
      /no model/
    )
    await expect(api.handle('chat.open', { conversationId: { $ne: 1 } })).rejects.toThrow()
  })

  it('stops and reads only runs of chats', async () => {
    const { api, deps, chat, runs } = setup()
    runs.set('run-1', run({ threadId: chat.id }))
    runs.set('sub', run({ id: 'sub', threadId: chat.id, surface: 'subagent' } as never))
    expect(await api.handle('run.stop', { runId: 'run-1' })).toEqual({ stopped: true })
    await expect(api.handle('run.stop', { runId: 'sub' })).rejects.toThrow()
    await expect(api.handle('run.stop', { runId: 'missing' })).rejects.toThrow()
    expect(deps.stopRun).toHaveBeenCalledTimes(1)
  })

  it('answers permission cards with a known decision, and chat-wide only when offered', async () => {
    const { api, deps, chat, runs, interactions } = setup()
    runs.set('run-1', run({ threadId: chat.id }))
    interactions.set('card', interaction({ kind: 'permission', request: {} }))
    await expect(
      api.handle('interaction.resolve', {
        interactionId: 'card',
        response: { decision: 'allow_chat' }
      })
    ).rejects.toThrow(/only be allowed once/)
    await expect(
      api.handle('interaction.resolve', { interactionId: 'card', response: { approved: true } })
    ).rejects.toThrow()
    await api.handle('interaction.resolve', {
      interactionId: 'card',
      response: { decision: 'deny_stop', extra: 'ignored' }
    })
    expect(deps.resolveInteraction).toHaveBeenCalledWith({
      interactionId: 'card',
      response: { approved: false, decision: 'deny_stop' }
    })
  })

  it('takes only the questions asked, and leaves cards that act on the computer to it', async () => {
    const { api, deps, chat, runs, interactions } = setup()
    runs.set('run-1', run({ threadId: chat.id }))
    interactions.set(
      'card',
      interaction({
        kind: 'question',
        request: { questions: [{ id: 'q1', question: 'Which?' }] }
      })
    )
    await api.handle('interaction.resolve', {
      interactionId: 'card',
      response: { q1: ['A', 7, ''], q2: 'not asked' }
    })
    expect(deps.resolveInteraction).toHaveBeenLastCalledWith({
      interactionId: 'card',
      response: { q1: ['A'] }
    })
    interactions.set(
      'sessions',
      interaction({ id: 'sessions', kind: 'question', request: { intent: 'start_sessions' } })
    )
    await expect(
      api.handle('interaction.resolve', { interactionId: 'sessions', response: {} })
    ).rejects.toThrow(/on the computer/)
    interactions.set('done', interaction({ id: 'done', status: 'resolved' }))
    await expect(
      api.handle('interaction.resolve', { interactionId: 'done', response: { decision: 'deny' } })
    ).rejects.toThrow(/already answered/)
  })

  it('opens a chat with its messages and the active run, without images', async () => {
    const { api, db, chat, runs } = setup()
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, images, timestamp)
       VALUES ('m1', ?, 'user', 'look', ?, 1)`
    ).run(chat.id, JSON.stringify([{ dataUrl: 'data:image/png;base64,AAAA' }]))
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, timestamp)
       VALUES ('m2', ?, 'agent', 'Here it is', 2)`
    ).run(chat.id)
    runs.set('run-1', run({ threadId: chat.id }))
    const detail = (await api.handle('chat.open', { conversationId: chat.id })) as {
      messages: unknown[]
      run: { run: AgentRunSnapshot } | null
    }
    expect(detail.messages).toEqual([
      { id: 'm1', role: 'user', content: 'look', timestamp: 1, imageCount: 1 },
      { id: 'm2', role: 'assistant', content: 'Here it is', timestamp: 2 }
    ])
    expect(detail.run?.run.id).toBe('run-1')
  })

  it('cuts long text and drops inline images when trimming for the phone', () => {
    expect(
      trimForPhone({
        text: 'x'.repeat(5_000),
        screenshot: { url: 'a' },
        preview: 'data:image/png;base64,AAAA',
        nested: [{ images: [1] }]
      })
    ).toEqual({ text: `${'x'.repeat(4_000)}… (shortened)`, nested: [{}] })
  })
})
