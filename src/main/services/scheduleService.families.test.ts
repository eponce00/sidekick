import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StartConversationAgentRunInput } from '../../shared/agentRunApi'
import type { AgentRunEvent, AgentRunPhase, AgentRunSnapshot } from '../../shared/agentRuntime'
import type { PinnedModel } from '../../shared/models'
import type { PermissionMode } from '../../shared/permissions'
import type { ScheduleInput } from '../../shared/schedules'
import { SESSION_LIMITS } from '../../shared/sessions'
import type { ProviderSettings } from '../../shared/settings'
import { applyDatabaseSchema } from '../bootstrap/database'
import { createScheduledConversationLauncher } from './scheduledConversationLauncher'
import { ScheduleService, type ScheduledRunFinishedNotice } from './scheduleService'
import { ScheduleStore } from './scheduleStore'
import { SessionService, type SessionRuntime } from './sessionService'
import { createSessionTools } from './sessionTools'

const MODEL_ID = 'ollama:local-1/qwen3:8b'
const MODEL: PinnedModel = { id: MODEL_ID, name: 'Qwen', provider: 'ollama' }

/** Runs kept in the database, as the real store keeps them, so the scheduler sees their phases. */
class DatabaseRuntime implements SessionRuntime {
  sessions!: SessionService
  schedules!: ScheduleService
  readonly started: StartConversationAgentRunInput[] = []
  private clock = 1_000

  constructor(private readonly db: Database.Database) {}

  async startRun(input: StartConversationAgentRunInput): Promise<unknown> {
    this.clock += 1
    this.db
      .prepare(
        `INSERT INTO agent_runs
         (id, thread_id, surface, phase, provider, model, profile_json, started_at, updated_at)
         VALUES (?, ?, 'conversation', 'streaming', 'ollama', 'qwen', '{}', ?, ?)`
      )
      .run(input.id, input.conversationId, this.clock, this.clock)
    this.started.push(input)
    this.emit(input.id, 'run.started')
    for (const steer of this.sessions.pendingSteers(input.conversationId, input.id))
      steer.onApplied?.()
    return {}
  }

  stopRun(runId: string): boolean {
    return this.setPhase(runId, 'cancelled')
  }

  // Messages wait for a chat's next run, which is enough for these tests.
  steer(): boolean {
    return false
  }

  latestRun(conversationId: string): AgentRunSnapshot | null {
    const row = this.db
      .prepare(
        'SELECT id FROM agent_runs WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1'
      )
      .get(conversationId) as { id: string } | undefined
    return row ? this.run(row.id) : null
  }

  run(runId: string): AgentRunSnapshot | null {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    return {
      id: row.id as string,
      threadId: row.thread_id as string,
      surface: 'conversation',
      executionMode: 'act',
      phase: row.phase as AgentRunPhase,
      provider: 'ollama',
      model: 'qwen',
      lastSequence: 0,
      startedAt: row.started_at as number,
      updatedAt: row.updated_at as number
    }
  }

  setPhase(runId: string, phase: AgentRunPhase): boolean {
    return (
      this.db.prepare('UPDATE agent_runs SET phase = ? WHERE id = ?').run(phase, runId).changes > 0
    )
  }

  /** Ends a run as finalization does: the reply is saved, then `run.finalized` reaches both. */
  async finish(runId: string, reply = '', phase: AgentRunPhase = 'completed'): Promise<void> {
    this.setPhase(runId, phase)
    const run = this.run(runId)!
    if (reply)
      this.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, role, content, run_id, timestamp)
           VALUES (?, ?, 'agent', ?, ?, ?)`
        )
        .run(randomUUID(), run.threadId, reply, runId, this.clock)
    this.emit(runId, 'run.finalized')
    await this.sessions.idle()
    this.schedules.agentRunFinalized(runId)
  }

  private emit(runId: string, type: AgentRunEvent['type']): void {
    this.sessions.observe({
      id: randomUUID(),
      runId,
      sequence: 1,
      type,
      timestamp: this.clock,
      payload: {}
    })
  }
}

let db: Database.Database
let runtime: DatabaseRuntime
let sessions: SessionService
let schedules: ScheduleService
let store: ScheduleStore
let setting: PermissionMode
let notices: ScheduledRunFinishedNotice[]

const schedule = (overrides: Partial<ScheduleInput> = {}): ScheduleInput => ({
  name: 'Nightly triage',
  prompt: 'Triage the open issues.',
  projectId: 'project',
  modelId: MODEL_ID,
  cadence: 'daily',
  hour: 3,
  minute: 0,
  weekday: 1,
  catchUp: true,
  ...overrides
})

const conversation = (id: string): Record<string, unknown> =>
  db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown>

const latestRunId = (conversationId: string): string => runtime.latestRun(conversationId)!.id

async function startScheduledChat(input: Partial<ScheduleInput> = {}): Promise<{
  scheduleId: string
  chatId: string
}> {
  const created = schedules.create(schedule(input))
  const run = await schedules.runNow(created.id)
  return { scheduleId: created.id, chatId: run.conversationId! }
}

const startWorkers = (managerId: string, count: number) =>
  sessions.start(
    {
      managerConversationId: managerId,
      sessions: Array.from({ length: count }, (_, index) => ({
        title: `Worker ${index + 1}`,
        brief: `Look at area ${index + 1}.`,
        workIn: 'folder' as const
      }))
    },
    'agent'
  )

beforeEach(() => {
  db = new Database(':memory:')
  applyDatabaseSchema(db)
  db.prepare(
    `INSERT INTO projects (id, name, folder_path, created_at, updated_at)
     VALUES ('project', 'sidekick', '/repo/sidekick', 1, 1)`
  ).run()
  setting = 'full-access'
  notices = []
  runtime = new DatabaseRuntime(db)
  sessions = new SessionService({
    db,
    runtime,
    worktrees: {
      isGitProject: async () => false,
      createForConversation: async () => ({}),
      removeIfUnused: async () => null
    },
    resolveModel: () => MODEL
  })
  store = new ScheduleStore(db)
  schedules = new ScheduleService({
    store,
    launcher: createScheduledConversationLauncher({
      db,
      settings: () =>
        ({
          providerInstances: [
            {
              id: 'local-1',
              type: 'ollama',
              name: 'Local',
              enabled: true,
              baseUrl: 'http://localhost:11434',
              modelSource: 'manual',
              models: [{ id: 'qwen3:8b', name: 'Qwen', enabled: true }]
            }
          ]
        }) as unknown as ProviderSettings,
      startConversationRun: (input) => runtime.startRun(input)
    }),
    onChange: () => undefined,
    permissionMode: () => setting,
    onFinished: (notice) => notices.push(notice)
  })
  runtime.sessions = sessions
  runtime.schedules = schedules
})

afterEach(() => db.close())

describe('schedules as starters', () => {
  it('marks a scheduled chat as started by its schedule, with the ceiling the schedule stored', async () => {
    const { chatId } = await startScheduledChat({ permissionCeiling: 'sensitive-only' })
    expect(conversation(chatId)).toMatchObject({
      started_by_kind: 'schedule',
      started_by_conversation_id: null,
      permission_ceiling: 'sensitive-only'
    })
  })

  it('stores the setting as the ceiling and refuses one looser than the setting', async () => {
    setting = 'sensitive-only'
    expect(schedules.create(schedule()).permissionCeiling).toBe('sensitive-only')
    expect(() => schedules.create(schedule({ permissionCeiling: 'full-access' }))).toThrow(
      /cannot allow more than your permission setting/
    )
    const strict = schedules.create(schedule({ permissionCeiling: 'always-ask' }))
    expect(strict.permissionCeiling).toBe('always-ask')

    // A ceiling saved earlier stays when the setting later becomes stricter.
    setting = 'full-access'
    const saved = schedules.create(schedule({ permissionCeiling: 'full-access' }))
    setting = 'always-ask'
    expect(schedules.update(saved.id, schedule({ name: 'Renamed' })).permissionCeiling).toBe(
      'full-access'
    )
    expect(() =>
      schedules.update(strict.id, schedule({ permissionCeiling: 'full-access' }))
    ).toThrow(/cannot allow more/)
  })

  it('lets a scheduled chat start workers within the family limits, and they inherit its ceiling', async () => {
    const { chatId } = await startScheduledChat({ permissionCeiling: 'sensitive-only' })
    const { started } = await startWorkers(chatId, 2)
    for (const worker of started) {
      expect(conversation(worker.conversationId)).toMatchObject({
        started_by_kind: 'session',
        started_by_conversation_id: chatId,
        report_to_conversation_id: chatId,
        permission_ceiling: 'sensitive-only'
      })
    }
    await expect(startWorkers(chatId, SESSION_LIMITS.liveWorkersPerFamily - 1)).rejects.toThrow(
      /at most 8/
    )
    // Workers cannot start chats of their own.
    await expect(startWorkers(started[0].conversationId, 1)).rejects.toThrow(/cannot start/)
  })

  it('asks the user before an unattended chat starts others when its ceiling says to', async () => {
    const { chatId } = await startScheduledChat({ permissionCeiling: 'sensitive-only' })
    const questions: Record<string, unknown>[] = []
    const tools = createSessionTools({
      service: sessions,
      // The setting alone would start them at once.
      permissionMode: () => 'full-access',
      requestUserDecision: async (runId, request) => {
        questions.push(request)
        return {
          id: 'interaction',
          runId,
          kind: 'question',
          status: 'cancelled',
          request,
          createdAt: 1
        }
      }
    })(chatId, latestRunId(chatId))!
    const result = (await tools.handler.execute(
      'start_session',
      { sessions: [{ title: 'Check docs', brief: 'Read the docs.', work_in: 'folder' }] },
      { runId: latestRunId(chatId), signal: new AbortController().signal }
    )) as { declined?: boolean }
    expect(questions).toHaveLength(1)
    expect(result.declined).toBe(true)
    expect(sessions.store.workers(chatId)).toHaveLength(0)
  })

  it('holds off the next occurrence while a chat the previous run started is still working', async () => {
    const { scheduleId, chatId } = await startScheduledChat()
    const { started } = await startWorkers(chatId, 1)
    await runtime.finish(latestRunId(chatId), 'Started a worker.')

    const skipped = await schedules.runNow(scheduleId)
    expect(skipped).toMatchObject({
      outcome: 'skipped',
      reason: 'Skipped: a chat the previous run started is still working.'
    })
    runtime.setPhase(latestRunId(started[0].conversationId), 'awaiting_permission')
    expect(store.get(scheduleId)!.activeRun).toMatchObject({
      conversationId: started[0].conversationId,
      phase: 'awaiting_permission'
    })
    expect((await schedules.runNow(scheduleId)).reason).toBe(
      'Skipped: a chat the previous run started is still waiting for your approval.'
    )
  })

  it('tells the user once the scheduled chat finishes with its family idle', async () => {
    const { scheduleId, chatId } = await startScheduledChat()
    const { started } = await startWorkers(chatId, 1)
    const worker = started[0].conversationId

    // The chat ends its turn while its worker works: nothing to announce yet.
    await runtime.finish(latestRunId(chatId), 'Waiting on the worker.')
    expect(notices).toEqual([])

    // The worker's report wakes the chat, which then finishes for good.
    const firstRun = latestRunId(chatId)
    await runtime.finish(latestRunId(worker), 'Found two duplicates.')
    expect(latestRunId(chatId)).not.toBe(firstRun)
    await runtime.finish(latestRunId(chatId), 'All triaged.')
    expect(notices).toEqual([
      {
        scheduleId,
        conversationId: chatId,
        title: 'Nightly triage · Run 1',
        reply: 'All triaged.'
      }
    ])
    // A repeated event announces nothing more.
    schedules.agentRunFinalized(latestRunId(chatId))
    expect(notices).toHaveLength(1)
  })

  it('does not announce a scheduled chat that failed; the attention tracker reports that', async () => {
    const { chatId } = await startScheduledChat()
    await runtime.finish(latestRunId(chatId), '', 'failed')
    expect(notices).toEqual([])
  })

  it("lists the run's family in the schedule's history", async () => {
    const { scheduleId, chatId } = await startScheduledChat()
    const { started } = await startWorkers(chatId, 2)
    await runtime.finish(latestRunId(started[0].conversationId), 'Done.')
    const [run] = schedules.runs(scheduleId)
    expect(run.workers).toEqual([
      {
        conversationId: started[0].conversationId,
        handle: 'worker-1',
        title: 'Worker 1',
        agentPhase: 'completed'
      },
      {
        conversationId: started[1].conversationId,
        handle: 'worker-2',
        title: 'Worker 2',
        agentPhase: 'streaming'
      }
    ])
  })
})
