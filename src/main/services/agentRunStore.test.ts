import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { AgentRunStore } from './agentRunStore'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

describe('AgentRunStore', () => {
  it('recovers an on-disk interrupted run once without duplicating recovery events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-run-reopen-'))
    let disk: Database.Database | undefined
    try {
      const path = join(root, 'state.db')
      disk = new Database(path)
      applyDatabaseSchema(disk)
      let durable = new AgentRunStore(disk)
      durable.start({
        id: 'disk-run',
        threadId: 'disk-thread',
        profile: {
          surface: 'conversation',
          executionMode: 'act',
          capabilities: ['workspace.read']
        },
        provider: 'openai-compatible',
        model: 'fixture',
        workspaceRoot: root
      })
      durable.transition('disk-run', 'streaming', 'start-stream')
      disk.close()
      disk = new Database(path)
      durable = new AgentRunStore(disk)
      expect(durable.recoverInterrupted('disk-thread')).toHaveLength(1)
      const events = durable.listEvents('disk-run')
      expect(durable.get('disk-run')?.phase).toBe('interrupted')
      expect(durable.recoverInterrupted('disk-thread')).toHaveLength(0)
      expect(durable.listEvents('disk-run')).toEqual(events)
    } finally {
      if (disk?.open) disk.close()
      await rm(root, { recursive: true, force: true })
    }
  })
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

  it('lets only the latest interrupted run of a conversation be continued', () => {
    const interrupted = start('run-1')
    store.transition(interrupted.id, 'streaming', 'stream-1')
    store.recoverInterrupted('thread-1')
    expect(store.canContinue('run-1', 'thread-1')).toBe(true)
    expect(store.canContinue('run-1', 'thread-2')).toBe(false)

    // The continuation is now the latest run, so a second one is refused.
    start('run-2')
    db.prepare('UPDATE agent_runs SET started_at = started_at + 1 WHERE id = ?').run('run-2')
    expect(store.canContinue('run-1', 'thread-1')).toBe(false)

    store.transition('run-2', 'completed', 'complete-2')
    expect(store.canContinue('run-2', 'thread-1')).toBe(false)
  })

  it('keeps a chat on its own run when a sub-agent starts after it in the same thread', () => {
    start('run-1')
    store.start({
      id: 'child-1',
      threadId: 'thread-1',
      parentRunId: 'run-1',
      profile: { surface: 'subagent', executionMode: 'act', capabilities: ['wait'] },
      provider: 'openai-compatible',
      model: 'test-model'
    })
    db.prepare('UPDATE agent_runs SET started_at = started_at + 1 WHERE id = ?').run('child-1')
    expect(store.latest('thread-1')?.id).toBe('run-1')
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
