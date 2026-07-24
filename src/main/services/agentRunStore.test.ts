import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { AgentRunStore } from './agentRunStore'

describe('AgentRunStore', () => {
  let db: Database.Database
  let store: AgentRunStore

  beforeEach(() => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    store = new AgentRunStore(db)
  })

  function start(id = 'run-1') {
    return store.start({
      id,
      threadId: 'thread-1',
      profile: {
        surface: 'conversation',
        executionMode: 'act',
        capabilities: ['workspace.read', 'workspace.write', 'wait']
      },
      provider: 'openai-compatible',
      model: 'test-model',
      workspaceRoot: '/workspace'
    })
  }

  it('assigns durable monotonic event sequences', () => {
    const run = start()
    expect(run.lastSequence).toBe(1)
    store.transition(run.id, 'streaming', 'phase-1')
    store.appendEvent({
      id: 'delta-1',
      runId: run.id,
      type: 'assistant.delta',
      payload: { content: 'hello' }
    })

    expect(store.listEvents(run.id).map(({ sequence, type }) => ({ sequence, type }))).toEqual([
      { sequence: 1, type: 'run.started' },
      { sequence: 2, type: 'run.phase' },
      { sequence: 3, type: 'assistant.delta' }
    ])
    expect(store.get(run.id)?.lastSequence).toBe(3)
  })

  it('persists pending questions and their resolution as events', () => {
    const run = start()
    store.transition(run.id, 'awaiting_user', 'await-user')
    const interaction = store.createInteraction({
      id: 'question-1',
      runId: run.id,
      kind: 'question',
      request: { questions: [{ id: 'format', question: 'Which format?' }] }
    })
    expect(interaction.status).toBe('pending')
    expect(store.listPendingInteractions(run.id)).toHaveLength(1)

    const resolved = store.resolveInteraction(interaction.id, { format: 'CSV' })
    expect(resolved).toMatchObject({ status: 'resolved', response: { format: 'CSV' } })
    expect(store.listPendingInteractions(run.id)).toHaveLength(0)
    expect(store.listEvents(run.id).map(({ type }) => type)).toEqual(
      expect.arrayContaining(['question.requested', 'question.resolved'])
    )
  })

  it('recovers active runs and cancels unresolved interactions atomically', () => {
    const run = start()
    store.transition(run.id, 'awaiting_user', 'await-user')
    store.createInteraction({
      id: 'question-1',
      runId: run.id,
      kind: 'question',
      request: { questions: [] }
    })

    expect(store.recoverInterrupted('thread-1')).toHaveLength(1)
    expect(store.get(run.id)?.phase).toBe('interrupted')
    expect(store.getInteraction('question-1')?.status).toBe('cancelled')
    expect(store.listEvents(run.id).map(({ type }) => type)).toContain('question.resolved')
    expect(store.listEvents(run.id).at(-1)?.payload).toMatchObject({ phase: 'interrupted' })
  })

  it('rejects transitions after a terminal state', () => {
    const run = start()
    store.transition(run.id, 'completed', 'complete')
    expect(() => store.transition(run.id, 'streaming', 'late')).toThrow('already terminal')
  })

  it('marks a successfully completed conversation as unread', () => {
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at)
       VALUES ('thread-1', 'Background chat', 1, 1)`
    ).run()
    const run = start()

    store.transition(run.id, 'completed', 'complete')

    const row = db
      .prepare('SELECT unread_completion_at FROM conversations WHERE id = ?')
      .get('thread-1') as { unread_completion_at: number | null }
    expect(row.unread_completion_at).toEqual(expect.any(Number))
  })

  it('does not mark a failed conversation as a completed unread response', () => {
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at)
       VALUES ('thread-1', 'Failed chat', 1, 1)`
    ).run()
    const run = start()

    store.transition(run.id, 'failed', 'failed')

    const row = db
      .prepare('SELECT unread_completion_at FROM conversations WHERE id = ?')
      .get('thread-1') as { unread_completion_at: number | null }
    expect(row.unread_completion_at).toBeNull()
  })
})
