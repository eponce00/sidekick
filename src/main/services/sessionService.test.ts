import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StartConversationAgentRunInput } from '../../shared/agentRunApi'
import type { AgentRunEvent, AgentRunPhase, AgentRunSnapshot } from '../../shared/agentRuntime'
import type { PinnedModel } from '../../shared/models'
import { SESSION_LIMITS, type SessionsChangedEvent } from '../../shared/sessions'
import { applyDatabaseSchema } from '../bootstrap/database'
import type { AgentRunSteer } from './agentRunKernel'
import { SessionService, type SessionRuntime, type SessionWorktrees } from './sessionService'

const MODEL: PinnedModel = { id: 'test:model', name: 'Model', provider: 'openrouter' }

/** Runs that live in memory: started, steered and finished by the test. */
class FakeRuntime implements SessionRuntime {
  readonly runs = new Map<string, AgentRunSnapshot>()
  readonly started: StartConversationAgentRunInput[] = []
  service!: SessionService
  private sequence = 0

  constructor(private readonly db: Database.Database) {}

  async startRun(input: StartConversationAgentRunInput): Promise<unknown> {
    const latest = this.latestRun(input.conversationId)
    if (latest && this.active(latest.phase)) throw new Error('already running')
    const run: AgentRunSnapshot = {
      id: input.id,
      threadId: input.conversationId,
      surface: 'conversation',
      executionMode: 'act',
      phase: 'streaming',
      provider: 'openrouter',
      model: 'model',
      lastSequence: 0,
      startedAt: Date.now() + this.sequence,
      updatedAt: Date.now()
    }
    this.runs.set(run.id, run)
    this.started.push(input)
    this.emit(run.id, 'run.started')
    // The kernel takes the chat's waiting messages before its first step.
    for (const steer of this.service.pendingSteers(input.conversationId, run.id))
      this.take(run, steer)
    return run
  }

  stopRun(runId: string): boolean {
    const run = this.runs.get(runId)
    if (!run || !this.active(run.phase)) return false
    this.finish(runId, 'cancelled')
    return true
  }

  steer(conversationId: string, steer: AgentRunSteer): boolean {
    const run = this.latestRun(conversationId)
    if (!run || run.phase !== 'streaming') return false
    this.take(run, steer)
    return true
  }

  latestRun(conversationId: string): AgentRunSnapshot | null {
    return (
      [...this.runs.values()]
        .filter((run) => run.threadId === conversationId)
        .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
    )
  }

  run(runId: string): AgentRunSnapshot | null {
    return this.runs.get(runId) ?? null
  }

  /** Ends a run the way finalization does: its reply is stored, then `run.finalized` fires. */
  finish(runId: string, phase: AgentRunPhase = 'completed', reply = ''): void {
    const run = this.runs.get(runId)!
    run.phase = phase
    if (reply)
      this.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, role, content, run_id, timestamp)
           VALUES (?, ?, 'agent', ?, ?, ?)`
        )
        .run(randomUUID(), run.threadId, reply, run.id, Date.now())
    this.emit(runId, 'run.finalized')
  }

  steered = new Map<string, string[]>()

  private take(run: AgentRunSnapshot, steer: AgentRunSteer): void {
    this.steered.set(run.id, [...(this.steered.get(run.id) ?? []), steer.id])
    this.emit(run.id, 'run.steered', steer.payload)
    steer.onApplied?.()
  }

  private active(phase: AgentRunPhase): boolean {
    return !['completed', 'failed', 'cancelled', 'interrupted'].includes(phase)
  }

  private emit(runId: string, type: AgentRunEvent['type'], payload: Record<string, unknown> = {}) {
    this.sequence += 1
    this.service.observe({
      id: randomUUID(),
      runId,
      sequence: this.sequence,
      type,
      timestamp: Date.now(),
      payload
    })
  }
}

let db: Database.Database
let runtime: FakeRuntime
let service: SessionService
let changes: SessionsChangedEvent[]
let worktreesCreated: string[]
const MANAGER = 'manager'

function runsOf(conversationId: string): StartConversationAgentRunInput[] {
  return runtime.started.filter((input) => input.conversationId === conversationId)
}

function lastRunId(conversationId: string): string {
  return runsOf(conversationId).at(-1)!.id
}

beforeEach(() => {
  db = new Database(':memory:')
  applyDatabaseSchema(db)
  db.exec(`
    INSERT INTO projects (id, name, folder_path, created_at, updated_at)
      VALUES ('project', 'sidekick', '/repo/sidekick', 1, 1),
             ('other', 'sidekick-api', '/repo/sidekick-api', 1, 1);
    INSERT INTO conversations (id, title, created_at, updated_at, project_id, home_workspace_root, home_project_name)
      VALUES ('manager', 'Design review', 1, 1, 'project', '/repo/sidekick', 'sidekick');
  `)
  runtime = new FakeRuntime(db)
  changes = []
  worktreesCreated = []
  const worktrees: SessionWorktrees = {
    isGitProject: async () => true,
    // Like the worktree service: a new project for the chat, and the chat moved into it.
    createForConversation: async ({ conversationId }) => {
      const projectId = `wt-${conversationId}`
      db.prepare(
        `INSERT INTO projects (id, name, folder_path, created_at, updated_at) VALUES (?, ?, ?, 1, 1)`
      ).run(projectId, `sidekick · ${conversationId}`, `/storage/${conversationId}`)
      db.prepare(
        `INSERT INTO managed_worktrees
         (id, project_id, source_project_id, repository_root, worktree_root, branch, created_at, last_used_at)
         VALUES (?, ?, 'project', '/repo/sidekick', ?, ?, 1, 1)`
      ).run(
        randomUUID(),
        projectId,
        `/storage/${conversationId}`,
        `sidekick/${conversationId.slice(0, 8)}`
      )
      db.prepare(
        'UPDATE conversations SET project_id = ?, home_workspace_root = ? WHERE id = ?'
      ).run(projectId, `/storage/${conversationId}`, conversationId)
      worktreesCreated.push(conversationId)
      return {}
    },
    removeIfUnused: async () => null
  }
  service = new SessionService({
    db,
    runtime,
    worktrees,
    resolveModel: () => MODEL,
    onChange: (change) => changes.push(change)
  })
  runtime.service = service
})

afterEach(() => {
  db.close()
})

async function startWorkers(...titles: string[]) {
  const result = await service.start(
    {
      managerConversationId: MANAGER,
      sessions: titles.map((title) => ({ title, brief: `Brief for ${title}` }))
    },
    'user'
  )
  return result.started
}

describe('starting, stopping and archiving workers', () => {
  it('starts a worker in its own worktree, stops it and archives it', async () => {
    const [worker] = await startWorkers('Port schedules')
    const row = service.store.conversation(worker.conversationId)!
    expect(row).toMatchObject({
      started_by_kind: 'session',
      started_by_conversation_id: MANAGER,
      report_to_conversation_id: MANAGER,
      session_handle: 'port-schedules',
      work_in: 'worktree',
      project_id: `wt-${worker.conversationId}`
    })
    expect(worktreesCreated).toEqual([worker.conversationId])
    const [run] = runsOf(worker.conversationId)
    expect(run.workspaceSharing).toBeUndefined()

    // The brief is both the worker's first message and a delivered session message.
    const [brief] = service.messages(worker.conversationId)
    expect(brief).toMatchObject({
      intent: 'brief',
      fromConversationId: MANAGER,
      deliveredRunId: run.id
    })
    expect(
      db
        .prepare("SELECT id, content FROM messages WHERE conversation_id = ? AND role = 'user'")
        .get(worker.conversationId)
    ).toEqual({ id: brief.id, content: 'Brief for Port schedules' })
    expect(service.family(MANAGER)?.workers.map(({ handle, state }) => [handle, state])).toEqual([
      ['port-schedules', 'working']
    ])
    expect(() => service.archive(worker.conversationId)).toThrow(/Stop this chat/)

    service.stop(worker.conversationId)
    await service.idle()
    expect(service.state(worker.conversationId)).toBe('stopped')
    const report = service.messages(MANAGER).find(({ intent }) => intent === 'report')!
    expect(report.body).toContain('Stopped before finishing.')
    expect(report.body).toContain(`Branch sidekick/${worker.conversationId.slice(0, 8)}`)

    service.archive(worker.conversationId)
    expect(service.store.conversation(worker.conversationId)?.archived_at).toEqual(
      expect.any(Number)
    )
    expect(service.family(MANAGER)).toBeNull()
    service.unarchive(worker.conversationId)
    expect(service.family(MANAGER)?.workers).toHaveLength(1)
  })

  it('refuses a batch before creating anything when one chat is invalid', async () => {
    await expect(
      service.start(
        {
          managerConversationId: MANAGER,
          sessions: [
            { title: 'Fine', brief: 'Do it' },
            { title: 'Bad', brief: 'Do it', handle: 'Not A Handle' }
          ]
        },
        'user'
      )
    ).rejects.toThrow(/lowercase/)
    expect(runtime.started).toEqual([])
    expect(service.store.workers(MANAGER)).toEqual([])
  })

  it('keeps families one level deep and caps live workers', async () => {
    const [worker] = await startWorkers('One')
    await expect(
      service.start(
        {
          managerConversationId: worker.conversationId,
          sessions: [{ title: 'Deeper', brief: 'x' }]
        },
        'agent'
      )
    ).rejects.toThrow(/cannot start chats of its own/)
    await expect(
      startWorkers(
        ...Array.from({ length: SESSION_LIMITS.liveWorkersPerFamily }, (_, i) => `More ${i}`)
      )
    ).rejects.toThrow(/at most/)
  })

  it('needs a grant for another project when an agent asks, and grants it for the user', async () => {
    const spec = {
      title: 'API contract',
      brief: 'Add tests',
      projectId: 'other',
      workIn: 'folder' as const
    }
    await expect(
      service.start({ managerConversationId: MANAGER, sessions: [spec] }, 'agent')
    ).rejects.toThrow(/until you allow it/)
    const [worker] = (
      await service.start({ managerConversationId: MANAGER, sessions: [spec] }, 'user')
    ).started
    expect(service.store.hasGrant(MANAGER, 'other')).toBe(true)
    expect(worker).toMatchObject({ projectId: 'other', workIn: 'folder' })
    expect(runsOf(worker.conversationId)[0].workspaceSharing).toBe('allow')
  })
})

describe('reports and wakes', () => {
  it('wakes the manager with every report only once the last worker goes idle', async () => {
    const [first, second] = await startWorkers('First', 'Second')
    runtime.finish(lastRunId(first.conversationId), 'completed', 'First is done.')
    await service.idle()
    expect(runsOf(MANAGER)).toEqual([])
    expect(service.store.undelivered(MANAGER).map(({ intent }) => intent)).toEqual(['report'])

    runtime.finish(lastRunId(second.conversationId), 'failed', 'Could not finish.')
    await service.idle()
    expect(runsOf(MANAGER)).toHaveLength(1)
    const managerRun = lastRunId(MANAGER)
    const reports = service.messages(MANAGER).filter(({ intent }) => intent === 'report')
    expect(
      reports.map(({ fromConversationId, deliveredRunId }) => [fromConversationId, deliveredRunId])
    ).toEqual([
      [first.conversationId, managerRun],
      [second.conversationId, managerRun]
    ])
    expect(reports[0].body).toContain('First is done.')
    expect(reports[1].body).toMatch(/^Failed/)
  })

  it('wakes the manager at once for a request, and steers messages into a running chat', async () => {
    const [asker, busy] = await startWorkers('Asker', 'Busy')
    const [request] = service.send({
      fromConversationId: asker.conversationId,
      to: 'manager',
      intent: 'request',
      body: 'Null or omit nextCursor?'
    })
    await service.idle()
    expect(runsOf(MANAGER)).toHaveLength(1)
    expect(service.store.message(request.id)?.deliveredRunId).toBe(lastRunId(MANAGER))

    // The manager answers while the asker is still running: the reply is steered in.
    const [reply] = service.send({
      fromConversationId: MANAGER,
      to: asker.handle!,
      intent: 'response',
      body: 'Null.',
      replyToMessageId: request.id
    })
    await service.idle()
    expect(service.store.message(reply.id)?.deliveredRunId).toBe(lastRunId(asker.conversationId))
    expect(runtime.steered.get(lastRunId(asker.conversationId))).toContain(reply.id)
    expect(runsOf(busy.conversationId)).toHaveLength(1)
  })

  it('never wakes anyone with a broadcast', async () => {
    const [sender, other] = await startWorkers('Sender', 'Other')
    runtime.finish(lastRunId(other.conversationId))
    await service.idle()
    const startedBefore = runtime.started.length
    const sent = service.send({
      fromConversationId: sender.conversationId,
      to: 'family',
      intent: 'request',
      body: 'FYI: the contract changed.'
    })
    await service.idle()
    expect(sent.map(({ intent, toConversationId }) => [intent, toConversationId]).sort()).toEqual(
      [
        ['update', MANAGER],
        ['update', other.conversationId]
      ].sort()
    )
    // The manager had a report waiting but a worker is still working, so it stays asleep too.
    expect(runtime.started.length).toBe(startedBefore)
  })

  it('tells the sender when a request ends unanswered', async () => {
    const [asker] = await startWorkers('Asker', 'Busy')
    const [request] = service.send({
      fromConversationId: asker.conversationId,
      to: 'manager',
      intent: 'request',
      body: 'Which branch?'
    })
    await service.idle()
    runtime.finish(lastRunId(MANAGER), 'completed', 'Looked around.')
    await service.idle()
    // The asker is still running, so the notice is steered straight in.
    const notice = service.messages(asker.conversationId).find(({ intent }) => intent === 'status')
    expect(notice).toMatchObject({
      replyToMessageId: request.id,
      fromConversationId: null,
      deliveredRunId: lastRunId(asker.conversationId)
    })
  })
})

describe('the automatic-turn limit', () => {
  it(`pauses a chat woken ${SESSION_LIMITS.automaticTurns} times in a row until the user acts`, async () => {
    const [worker] = await startWorkers('Chatty')
    runtime.finish(lastRunId(worker.conversationId))
    await service.idle()
    // The worker's report woke the manager once already.
    runtime.finish(lastRunId(MANAGER))
    await service.idle()
    const ask = async () => {
      service.send({
        fromConversationId: worker.conversationId,
        to: 'manager',
        intent: 'request',
        body: 'Again?'
      })
      await service.idle()
    }
    for (let turn = 2; turn <= SESSION_LIMITS.automaticTurns; turn++) {
      await ask()
      runtime.finish(lastRunId(MANAGER))
      await service.idle()
    }
    expect(runsOf(MANAGER)).toHaveLength(SESSION_LIMITS.automaticTurns)

    await ask()
    expect(runsOf(MANAGER)).toHaveLength(SESSION_LIMITS.automaticTurns)
    expect(service.pausedConversationIds()).toEqual([MANAGER])
    expect(
      db
        .prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'system'")
        .get(MANAGER)
    ).toEqual({ content: expect.stringContaining('Paused after 20 turns') })

    // The user's own message starts a run, which takes the waiting request and resets the count.
    await runtime.startRun({
      id: 'user-run',
      conversationId: MANAGER,
      assistantMessageId: 'a',
      model: MODEL
    })
    expect(service.pausedConversationIds()).toEqual([])
    expect(service.store.undelivered(MANAGER)).toEqual([])
    runtime.finish('user-run')
    await service.idle()
    await ask()
    expect(lastRunId(MANAGER)).not.toBe('user-run')
  })
})

describe('proposals', () => {
  it('records a suggestion without starting anything, then starts it on request', async () => {
    const { proposals } = await service.start(
      {
        managerConversationId: MANAGER,
        mode: 'propose',
        sessions: [{ title: 'Fix flaky test', brief: 'Find it' }]
      },
      'agent'
    )
    expect(runtime.started).toEqual([])
    const started = await service.startProposal(proposals[0].id)
    expect(service.store.proposal(proposals[0].id)).toMatchObject({
      status: 'started',
      startedConversationId: started.conversationId
    })
    expect(() => service.dismissProposal(proposals[0].id)).toThrow(/no longer open/)
  })
})

describe('restart recovery', () => {
  it('lists interrupted workers and never resumes them on its own', async () => {
    const [first, second] = await startWorkers('Port schedules', 'Write docs')
    // As the runtime's restart recovery does: active runs become interrupted.
    for (const worker of [first, second]) {
      const run = runtime.latestRun(worker.conversationId)!
      Object.assign(run, { phase: 'interrupted', completedAt: Date.now() })
    }
    const before = runtime.started.length
    service.recoverAfterRestart(0)
    await service.idle()
    expect(runtime.started).toHaveLength(before)

    expect(
      service.interrupted(MANAGER).map(({ handle, canResume }) => [handle, canResume])
    ).toEqual(
      expect.arrayContaining([
        ['port-schedules', true],
        ['write-docs', true]
      ])
    )
    expect(service.state(first.conversationId)).toBe('failed')
    expect(service.interrupted('someone-else')).toEqual([])
  })

  it('tells the manager once, without waking it', async () => {
    const [worker] = await startWorkers('Port schedules')
    Object.assign(runtime.latestRun(worker.conversationId)!, {
      phase: 'interrupted',
      completedAt: Date.now()
    })
    const managerRuns = runsOf(MANAGER).length
    service.recoverAfterRestart(0)
    await service.idle()
    const notes = service
      .messages(MANAGER)
      .filter(({ intent, toConversationId }) => intent === 'status' && toConversationId === MANAGER)
    expect(notes).toHaveLength(1)
    expect(notes[0].body).toContain('port-schedules')
    expect(notes[0].body).toContain('will not resume on its own')
    expect(runsOf(MANAGER)).toHaveLength(managerRuns)

    // A worker interrupted before this start was already reported last time.
    service.recoverAfterRestart(Date.now() + 1_000)
    expect(service.messages(MANAGER).filter(({ intent }) => intent === 'status')).toHaveLength(1)
  })

  it('resumes an interrupted worker by continuing its run', async () => {
    const [worker] = await startWorkers('Port schedules')
    const interrupted = runtime.latestRun(worker.conversationId)!
    Object.assign(interrupted, { phase: 'interrupted', completedAt: Date.now() })
    const result = await service.resume(worker.conversationId)
    const resumed = runsOf(worker.conversationId).at(-1)!
    expect(resumed).toMatchObject({ id: result.runId, continuesRunId: interrupted.id })
    expect(resumed.workspaceSharing).toBeUndefined()
    expect(service.state(worker.conversationId)).toBe('working')
    await expect(service.resume(worker.conversationId)).rejects.toThrow('no interrupted run')
  })
})
