import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { AgentRunEvent, AgentRunEventType, AgentRunSurface } from '../../shared/agentRuntime'
import type { SessionsChangedEvent } from '../../shared/sessions'
import { openApplicationDatabase } from '../bootstrap/database'
import { AgentRunStore } from './agentRunStore'
import { databaseSessionSources, SessionStatusService } from './sessionStatus'

let db: Database.Database
let store: AgentRunStore
let active: Set<string>
let service: SessionStatusService
let changes: SessionsChangedEvent[]
let sequence = 0

function addChat(id: string, extra: { manager?: string; archived?: boolean } = {}): void {
  db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at, started_by_conversation_id,
       started_by_kind, archived_at)
     VALUES (?, ?, 1, 1, ?, ?, ?)`
  ).run(
    id,
    id,
    extra.manager ?? null,
    extra.manager ? 'session' : 'user',
    extra.archived ? 2 : null
  )
}

function event(runId: string, type: AgentRunEventType, payload = {}): AgentRunEvent {
  sequence += 1
  return { id: `${runId}:${sequence}`, runId, sequence, type, timestamp: sequence, payload }
}

/** Starts a run the way the runtime does, with no renderer involved, and reports it. */
function startRun(runId: string, threadId: string, surface: AgentRunSurface = 'conversation') {
  active.add(threadId)
  store.start({
    id: runId,
    threadId,
    profile: { surface, executionMode: 'act', capabilities: [] },
    provider: 'fixture',
    model: 'fixture'
  })
  service.observe(event(runId, 'run.started'))
}

function finishRun(runId: string, phase: 'completed' | 'failed' | 'cancelled', message?: string) {
  const run = store.get(runId)!
  store.transition(
    runId,
    phase,
    `${runId}:end`,
    message ? ({ code: 'provider', message } as never) : undefined
  )
  active.delete(run.threadId)
  service.observe(event(runId, 'run.completed', { phase }))
}

function create(): SessionStatusService {
  const created = new SessionStatusService({
    ...databaseSessionSources(db),
    runIdentity: (runId) => store.get(runId),
    activeConversationIds: () => [...active]
  })
  created.onChange((change) => changes.push(change))
  return created
}

function stateOf(id: string): string {
  return service.status(id)?.state ?? 'idle'
}

beforeEach(() => {
  db = openApplicationDatabase(':memory:')
  store = new AgentRunStore(db)
  active = new Set()
  changes = []
  service = create()
})

afterEach(() => {
  db.close()
})

describe('SessionStatusService', () => {
  it('shows a run started in the main process as working with no chat panel mounted', () => {
    addChat('scheduled')
    service.start()
    expect(service.statuses()).toEqual([])

    startRun('run-1', 'scheduled')

    expect(service.status('scheduled')).toMatchObject({ state: 'working' })
    expect(changes.at(-1)).toMatchObject({
      kind: 'status',
      conversationIds: ['scheduled'],
      statuses: [{ conversationId: 'scheduled', state: 'working' }]
    })
    expect(service.counts().working).toBe(1)
  })

  it('shows a run as working while it is still being prepared', () => {
    addChat('chat')
    service.start()
    active.add('chat')
    service.refresh(['chat'])
    expect(stateOf('chat')).toBe('working')
    active.delete('chat')
    service.refresh(['chat'])
    expect(stateOf('chat')).toBe('idle')
  })

  it('waits on approvals and questions, announcing only the first', () => {
    addChat('chat')
    service.start()
    startRun('run-1', 'chat')

    service.observe(event('run-1', 'permission.requested', { interactionId: 'p1' }))
    expect(service.status('chat')).toMatchObject({ state: 'waiting', reason: 'Approval' })
    expect(changes.at(-1)?.alerts).toEqual([{ conversationId: 'chat', reason: 'approval' }])
    expect(service.waitingConversationIds()).toEqual(['chat'])

    const before = changes.length
    service.observe(event('run-1', 'question.requested', { interactionId: 'q1', kind: 'question' }))
    expect(changes.slice(before).flatMap((change) => change.alerts ?? [])).toEqual([])

    service.observe(event('run-1', 'permission.resolved', { interactionId: 'p1' }))
    expect(service.status('chat')).toMatchObject({ state: 'waiting', reason: 'Question' })
    service.observe(event('run-1', 'question.resolved', { interactionId: 'q1' }))
    expect(stateOf('chat')).toBe('working')
  })

  it('marks a finished reply done until it is read', () => {
    addChat('chat')
    service.start()
    startRun('run-1', 'chat')
    finishRun('run-1', 'completed')
    expect(stateOf('chat')).toBe('done')

    db.prepare('UPDATE conversations SET unread_completion_at = NULL WHERE id = ?').run('chat')
    service.refresh(['chat'])
    expect(stateOf('chat')).toBe('idle')
    expect(service.statuses()).toEqual([])
    expect(changes.at(-1)?.statuses).toEqual([
      expect.objectContaining({ conversationId: 'chat', state: 'idle' })
    ])
  })

  it('reports failed and stopped runs, announcing the failure', () => {
    addChat('broken')
    addChat('stopped')
    service.start()
    startRun('run-1', 'broken')
    finishRun('run-1', 'failed', 'The provider refused the request')
    expect(service.status('broken')).toMatchObject({
      state: 'failed',
      reason: 'The provider refused the request'
    })
    expect(changes.at(-1)?.alerts).toEqual([{ conversationId: 'broken', reason: 'failed' }])

    startRun('run-2', 'stopped')
    finishRun('run-2', 'cancelled')
    expect(service.status('stopped')).toMatchObject({ state: 'stopped', reason: 'Stopped' })
  })

  it('computes states from stored runs at startup, before any window asks', () => {
    addChat('crashed')
    addChat('finished')
    addChat('quiet')
    store.start({
      id: 'left-running',
      threadId: 'crashed',
      profile: { surface: 'conversation', executionMode: 'act', capabilities: [] },
      provider: 'fixture',
      model: 'fixture'
    })
    store.start({
      id: 'done-run',
      threadId: 'finished',
      profile: { surface: 'conversation', executionMode: 'act', capabilities: [] },
      provider: 'fixture',
      model: 'fixture'
    })
    store.transition('done-run', 'completed', 'done-run:end')

    service.start()

    expect(service.status('crashed')).toMatchObject({ state: 'failed', reason: 'Interrupted' })
    expect(stateOf('finished')).toBe('done')
    expect(stateOf('quiet')).toBe('idle')
  })

  it('rolls a family up to its manager, most urgent first, leaving out archived workers', () => {
    addChat('manager')
    addChat('worker-a', { manager: 'manager' })
    addChat('worker-b', { manager: 'manager' })
    addChat('old-worker', { manager: 'manager', archived: true })
    service.start()

    startRun('run-a', 'worker-a')
    expect(service.status('manager')).toMatchObject({
      state: 'idle',
      family: { state: 'working', counts: expect.objectContaining({ working: 1 }) }
    })

    startRun('run-b', 'worker-b')
    startRun('run-old', 'old-worker')
    service.observe(event('run-b', 'permission.requested', { interactionId: 'p1' }))
    expect(service.status('manager')?.family).toEqual({
      state: 'waiting',
      counts: expect.objectContaining({ working: 1, waiting: 1 })
    })

    finishRun('run-a', 'completed')
    service.observe(event('run-b', 'permission.resolved', { interactionId: 'p1' }))
    finishRun('run-b', 'completed')
    expect(service.status('manager')?.family?.state).toBe('done')
  })

  it('leaves group chats out and does not read the database while a reply streams', () => {
    addChat('chat')
    const sources = databaseSessionSources(db)
    const durable = vi.fn(sources.durableFacts)
    service = new SessionStatusService({
      ...sources,
      durableFacts: durable,
      runIdentity: (runId) => store.get(runId),
      activeConversationIds: () => [...active]
    })
    service.onChange((change) => changes.push(change))
    service.start()
    startRun('group-run', 'group-session', 'collaboration')
    expect(service.statuses()).toEqual([])

    startRun('run-1', 'chat')
    durable.mockClear()
    const before = changes.length
    service.observe(event('run-1', 'assistant.delta', { content: 'Hi' }))
    service.observe(event('run-1', 'tool.output.delta', { content: '…' }))
    expect(changes).toHaveLength(before)
    expect(durable).not.toHaveBeenCalled()
  })

  it('forgets a deleted chat', () => {
    addChat('chat')
    service.start()
    startRun('run-1', 'chat')
    finishRun('run-1', 'completed')
    db.prepare('DELETE FROM conversations WHERE id = ?').run('chat')
    service.refresh(['chat'])
    expect(service.statuses()).toEqual([])
  })

  it('publishes nothing when a refresh changes nothing', () => {
    addChat('chat')
    service.start()
    startRun('run-1', 'chat')
    const before = changes.length
    service.refresh(['chat'])
    expect(changes).toHaveLength(before)
  })
})
