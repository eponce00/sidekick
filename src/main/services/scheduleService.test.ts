import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import type { AgentRunPhase } from '../../shared/agentRuntime'
import type { StartConversationAgentRunInput } from '../../shared/agentRunApi'
import type { PinnedModel } from '../../shared/models'
import type { ProviderSettings } from '../../shared/settings'
import type { ScheduleInput, SchedulesChangedEvent } from '../../shared/schedules'
import type { WorkspaceOccupant } from '../../shared/worktrees'
import { ConversationAttentionTracker } from './conversationAttention'
import { createScheduledConversationLauncher } from './scheduledConversationLauncher'
import { ScheduleService } from './scheduleService'
import { ScheduleStore } from './scheduleStore'

const at = (day: number, hour: number, minute = 0, second = 0): number =>
  new Date(2026, 9, day, hour, minute, second).getTime()

const MODEL_ID = 'ollama:local-1/qwen3:8b'

function settings(modelEnabled = true): ProviderSettings {
  return {
    commandPermissionMode: 'always-ask',
    providerInstances: [
      {
        id: 'local-1',
        type: 'ollama',
        name: 'Local',
        enabled: true,
        baseUrl: 'http://localhost:11434',
        modelSource: 'manual',
        models: [{ id: 'qwen3:8b', name: 'Qwen 3 8B', enabled: modelEnabled }]
      }
    ]
  } as unknown as ProviderSettings
}

interface Harness {
  db: Database.Database
  service: ScheduleService
  store: ScheduleStore
  starts: StartConversationAgentRunInput[]
  changes: SchedulesChangedEvent[]
  timers: Array<{ callback: () => void; delayMs: number }>
  clock: { now: number }
  setModelEnabled: (enabled: boolean) => void
  failStart: (message: string | null) => void
  setPhase: (agentRunId: string, phase: AgentRunPhase) => void
}

/** Who is writing in the project folder, whether it is a Git repository, and queued runs. */
interface PlacementFixture {
  occupants?: WorkspaceOccupant[]
  git?: boolean
  queuedRunIds?: Set<string>
  worktreesCreated?: string[]
}

function harness(now: number, placement: PlacementFixture = {}): Harness {
  const db = new Database(':memory:')
  applyDatabaseSchema(db)
  db.prepare(
    `INSERT INTO projects (id, name, folder_path, created_at, updated_at)
     VALUES ('project-1', 'demo', 'C:/demo', 1, 1)`
  ).run()
  const clock = { now }
  let modelEnabled = true
  let startError: string | null = null
  const starts: StartConversationAgentRunInput[] = []
  const changes: SchedulesChangedEvent[] = []
  const timers: Array<{ callback: () => void; delayMs: number }> = []
  const store = new ScheduleStore(db)
  // The real launcher, with the runtime's entry point replaced by one that records the agent
  // run the way `AgentRunStore` would.
  const launcher = createScheduledConversationLauncher({
    db,
    settings: () => settings(modelEnabled),
    now: () => clock.now,
    folderOccupants: () => placement.occupants ?? [],
    isRunQueued: (agentRunId) => placement.queuedRunIds?.has(agentRunId) ?? false,
    worktrees: {
      isGitProject: async () => placement.git ?? false,
      create: async (projectId, title) => {
        const id = `worktree-${(placement.worktreesCreated ??= []).length + 1}`
        db.prepare(
          `INSERT INTO projects (id, name, folder_path, created_at, updated_at)
           VALUES (?, ?, ?, 1, 1)`
        ).run(id, `demo · sidekick/${title}`, `C:/worktrees/${projectId}/${id}`)
        placement.worktreesCreated.push(id)
        return { projectId: id, branch: 'sidekick/morning-check' }
      },
      discard: async () => undefined
    },
    startConversationRun: async (input) => {
      if (startError) throw new Error(startError)
      starts.push(input)
      db.prepare(
        `INSERT INTO agent_runs
         (id, thread_id, surface, phase, provider, model, profile_json, started_at, updated_at)
         VALUES (?, ?, 'conversation', 'streaming', 'ollama', 'qwen3:8b', '{}', ?, ?)`
      ).run(input.id, input.conversationId, clock.now, clock.now)
    }
  })
  const service = new ScheduleService({
    store,
    launcher,
    onChange: (change) => changes.push(change),
    now: () => clock.now,
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer as (typeof timers)[number])
      if (index >= 0) timers.splice(index, 1)
    },
    startDelayMs: 0
  })
  return {
    db,
    service,
    store,
    starts,
    changes,
    timers,
    clock,
    setModelEnabled: (enabled) => {
      modelEnabled = enabled
    },
    failStart: (message) => {
      startError = message
    },
    setPhase: (agentRunId, phase) => {
      db.prepare('UPDATE agent_runs SET phase = ? WHERE id = ?').run(phase, agentRunId)
    }
  }
}

const daily = (overrides: Partial<ScheduleInput> = {}): ScheduleInput => ({
  name: 'Morning check',
  prompt: 'Summarize what changed yesterday.',
  projectId: 'project-1',
  modelId: MODEL_ID,
  cadence: 'daily',
  hour: 9,
  minute: 0,
  weekday: 1,
  catchUp: true,
  ...overrides
})

describe('ScheduleService timing', () => {
  let h: Harness
  beforeEach(() => {
    h = harness(at(16, 8))
  })

  it('computes the first run from now and does nothing before it is due', async () => {
    const schedule = h.service.create(daily())
    expect(schedule.nextRunAt).toBe(at(16, 9))
    h.clock.now = at(16, 8, 59, 59)
    await h.service.tick()
    expect(h.starts).toHaveLength(0)
  })

  it('starts one run at its time and moves to the next day', async () => {
    const schedule = h.service.create(daily())
    h.clock.now = at(16, 9, 0, 1)
    await Promise.all([h.service.tick(), h.service.tick()])

    expect(h.starts).toHaveLength(1)
    const [run] = h.service.runs(schedule.id)
    expect(run).toMatchObject({
      outcome: 'started',
      runNumber: 1,
      trigger: 'schedule',
      late: false,
      scheduledFor: at(16, 9),
      agentPhase: 'streaming'
    })
    expect(h.store.get(schedule.id)).toMatchObject({ nextRunAt: at(17, 9), runCount: 1 })
    const conversation = h.db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(run.conversationId) as Record<string, unknown>
    expect(conversation).toMatchObject({
      title: 'Morning check · Run 1',
      project_id: 'project-1',
      schedule_id: schedule.id,
      schedule_run_number: 1,
      title_source: 'preserved'
    })
    expect(
      h.db
        .prepare('SELECT role, content FROM messages WHERE conversation_id = ?')
        .all(run.conversationId)
    ).toEqual([{ role: 'user', content: 'Summarize what changed yesterday.' }])
    // The last change carries the started agent run, so the sidebar can show it working.
    expect(h.changes.at(-1)).toMatchObject({
      conversationId: run.conversationId,
      schedules: [
        expect.objectContaining({
          activeRun: {
            conversationId: run.conversationId,
            agentRunId: h.starts[0].id,
            phase: 'streaming'
          }
        })
      ]
    })
  })

  it('treats a short timer delay as on time', async () => {
    const schedule = h.service.create(daily())
    h.clock.now = at(16, 9, 1, 30)
    await h.service.tick()
    expect(h.service.runs(schedule.id)[0]).toMatchObject({ outcome: 'started', late: false })
  })

  it('never waits longer than a minute, so a long sleep cannot hide a due time', () => {
    h.service.create(daily({ cadence: 'weekly', weekday: 3 }))
    h.service.start()
    const armed = h.timers.at(-1)!
    expect(armed.delayMs).toBeLessThanOrEqual(60_000)
  })

  it('wakes on its timer and checks again', async () => {
    h.service.create(daily())
    h.service.start()
    h.clock.now = at(16, 9)
    h.timers.at(-1)!.callback()
    await h.service.tick()
    expect(h.starts).toHaveLength(1)
    expect(h.timers.length).toBeGreaterThan(0)
  })

  it('numbers runs without gaps and keeps chats when the schedule is deleted', async () => {
    const schedule = h.service.create(daily({ cadence: 'hourly', minute: 0 }))
    for (const hour of [9, 10]) {
      h.clock.now = at(16, hour)
      await h.service.tick()
      h.setPhase(h.starts.at(-1)!.id, 'completed')
    }
    expect(h.service.runs(schedule.id).map((run) => run.runNumber)).toEqual([2, 1])
    expect(h.service.delete(schedule.id)).toBe(true)
    const rows = h.db
      .prepare('SELECT schedule_id, title FROM conversations ORDER BY created_at')
      .all() as Array<{ schedule_id: string | null }>
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.schedule_id === null)).toBe(true)
  })

  it('runs now while paused without moving the next time', async () => {
    const schedule = h.service.create(daily())
    h.service.pause(schedule.id)
    const run = await h.service.runNow(schedule.id)
    expect(run).toMatchObject({ outcome: 'started', trigger: 'manual', runNumber: 1 })
    expect(h.store.get(schedule.id)).toMatchObject({ enabled: false, nextRunAt: null })
    expect(h.service.resume(schedule.id).nextRunAt).toBe(at(16, 9))
  })
})

describe('ScheduleService missed runs', () => {
  it('collapses runs missed while closed or asleep into one late run', async () => {
    const h = harness(at(13, 8))
    const schedule = h.service.create(daily())
    // Asleep from the 13th until 10:30 on the 16th: four 9:00 runs were missed.
    h.clock.now = at(16, 10, 30)
    await h.service.tick()

    expect(h.starts).toHaveLength(1)
    const runs = h.service.runs(schedule.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ outcome: 'started', late: true, scheduledFor: at(16, 9) })
    expect(runs[0].reason).toMatch(/3 earlier times were skipped/)
    // The next time comes from now, so waking never produces a burst of runs.
    expect(h.store.get(schedule.id)!.nextRunAt).toBe(at(17, 9))
    await h.service.tick()
    expect(h.starts).toHaveLength(1)
  })

  it('records missed runs as skipped when catch-up is off', async () => {
    const h = harness(at(15, 8))
    const schedule = h.service.create(daily({ catchUp: false }))
    h.clock.now = at(16, 12)
    await h.service.tick()

    expect(h.starts).toHaveLength(0)
    expect(h.service.runs(schedule.id)).toEqual([
      expect.objectContaining({
        outcome: 'skipped',
        late: true,
        scheduledFor: at(16, 9),
        reason: expect.stringMatching(/Skipped 2 times/)
      })
    ])
    expect(h.store.get(schedule.id)!.nextRunAt).toBe(at(17, 9))
  })

  it('catches up after the app was closed, once the service starts', async () => {
    const first = harness(at(15, 8))
    const schedule = first.service.create(daily())
    // Reopen later with the same database, as after a restart.
    first.clock.now = at(16, 9, 30)
    first.service.start()
    first.timers.at(-1)!.callback()
    await first.service.tick()
    expect(first.service.runs(schedule.id)).toHaveLength(1)
    expect(first.service.runs(schedule.id)[0]).toMatchObject({ late: true, outcome: 'started' })
  })
})

describe('ScheduleService permissions and overlap', () => {
  it('waits for the user instead of starting another run behind an unanswered approval', async () => {
    const h = harness(at(16, 8))
    const schedule = h.service.create(daily({ cadence: 'hourly', minute: 0 }))
    h.clock.now = at(16, 9)
    await h.service.tick()
    h.setPhase(h.starts[0].id, 'awaiting_permission')
    expect(h.store.get(schedule.id)!.activeRun).toEqual({
      conversationId: h.starts[0].conversationId,
      agentRunId: h.starts[0].id,
      phase: 'awaiting_permission'
    })

    h.clock.now = at(16, 10)
    await h.service.tick()
    expect(h.starts).toHaveLength(1)
    expect(h.service.runs(schedule.id)[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'Skipped: the previous run is still waiting for your approval.'
    })

    // The main process reports the phase itself, so the dialog shows the wait at once.
    h.changes.length = 0
    h.service.agentRunChanged(h.starts[0].id, false)
    h.service.agentRunChanged('a-chat-the-user-started', false)
    expect(h.changes).toHaveLength(1)
    expect(h.changes[0].schedules[0].activeRun?.phase).toBe('awaiting_permission')

    // Once the user answers and the run ends, the next occurrence starts normally.
    h.setPhase(h.starts[0].id, 'completed')
    expect(h.store.get(schedule.id)!.activeRun).toBeUndefined()
    h.clock.now = at(16, 11)
    await h.service.tick()
    expect(h.starts).toHaveLength(2)
  })

  it('starts each run in a fresh chat through the ordinary run entry point', async () => {
    const h = harness(at(16, 8))
    h.service.create(daily({ cadence: 'hourly', minute: 0 }))
    for (const hour of [9, 10]) {
      h.clock.now = at(16, hour)
      await h.service.tick()
      h.setPhase(h.starts.at(-1)!.id, 'completed')
    }
    // No permission field exists to override: the runtime applies the mode from Settings, and a
    // new conversation carries no "allow for this chat" grant from an earlier run.
    for (const input of h.starts) {
      expect(Object.keys(input).sort()).toEqual(
        ['assistantMessageId', 'conversationId', 'id', 'mode', 'model'].sort()
      )
      expect(input.mode).toBe('conversation')
      expect((input.model as PinnedModel).id).toBe(MODEL_ID)
    }
    expect(new Set(h.starts.map(({ conversationId }) => conversationId)).size).toBe(2)
  })

  it('marks the chat as needing attention when its run asks for approval', async () => {
    const h = harness(at(16, 8))
    h.service.create(daily())
    h.clock.now = at(16, 9)
    await h.service.tick()
    const start = h.starts[0]
    const onChange = vi.fn()
    const attention = new ConversationAttentionTracker(
      (runId) =>
        runId === start.id ? { threadId: start.conversationId, surface: 'conversation' } : null,
      onChange
    )
    attention.observe({
      id: 'event-1',
      runId: start.id,
      sequence: 1,
      type: 'permission.requested',
      timestamp: h.clock.now,
      payload: { interactionId: 'interaction-1', kind: 'permission' }
    })
    expect(onChange).toHaveBeenLastCalledWith({
      waitingConversationIds: [start.conversationId],
      alert: { conversationId: start.conversationId, reason: 'approval' }
    })
  })

  it('pauses instead of falling back when its model is no longer enabled', async () => {
    const h = harness(at(16, 8))
    const schedule = h.service.create(daily())
    h.setModelEnabled(false)
    h.clock.now = at(16, 9)
    await h.service.tick()

    expect(h.starts).toHaveLength(0)
    expect(h.service.runs(schedule.id)[0]).toMatchObject({ outcome: 'failed' })
    expect(h.store.get(schedule.id)).toMatchObject({
      enabled: false,
      nextRunAt: null,
      pausedReason: expect.stringMatching(/model is no longer enabled/)
    })
    expect(h.db.prepare('SELECT count(*) AS count FROM conversations').get()).toEqual({ count: 0 })
  })

  it('pauses when its project folder was removed', async () => {
    const h = harness(at(16, 8))
    const schedule = h.service.create(daily())
    h.db.prepare("DELETE FROM projects WHERE id = 'project-1'").run()
    h.clock.now = at(16, 9)
    await h.service.tick()
    expect(h.starts).toHaveLength(0)
    expect(h.store.get(schedule.id)!.pausedReason).toMatch(/project folder was removed/)
  })

  it('records a run that could not start and tells the chat why', async () => {
    const h = harness(at(16, 8))
    const schedule = h.service.create(daily())
    h.failStart('Provider is offline')
    h.clock.now = at(16, 9)
    await h.service.tick()

    const [run] = h.service.runs(schedule.id)
    expect(run).toMatchObject({ outcome: 'failed', reason: 'Could not start: Provider is offline' })
    expect(
      h.db
        .prepare('SELECT role, notice_tone FROM messages WHERE conversation_id = ? AND role = ?')
        .all(run.conversationId, 'system')
    ).toEqual([{ role: 'system', notice_tone: 'error' }])
    // A provider outage is not a configuration problem, so the schedule keeps its time.
    expect(h.store.get(schedule.id)).toMatchObject({ enabled: true, nextRunAt: at(17, 9) })
  })
})

describe('ScheduleService and a busy project folder', () => {
  const busy: WorkspaceOccupant[] = [
    {
      runId: 'other-run',
      conversationId: 'other',
      title: 'Fix the build',
      workspaceRoot: 'C:/demo'
    }
  ]

  it('starts in the project folder when no other agent is writing there', async () => {
    const h = harness(at(16, 8))
    const schedule = h.service.create(daily())
    const run = await h.service.runNow(schedule.id)
    expect(run).toMatchObject({ outcome: 'started' })
    expect(
      h.db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(run.conversationId)
    ).toEqual({ project_id: 'project-1' })
  })

  it('starts in a fresh worktree when the busy folder is a Git repository', async () => {
    const fixture: PlacementFixture = { occupants: busy, git: true }
    const h = harness(at(16, 8), fixture)
    const schedule = h.service.create(daily())
    const run = await h.service.runNow(schedule.id)
    expect(run).toMatchObject({ outcome: 'started' })
    expect(run.reason).toBe(
      'Started in a new worktree on sidekick/morning-check because “Fix the build” was working in the project folder.'
    )
    expect(
      h.db
        .prepare('SELECT project_id, home_workspace_root FROM conversations WHERE id = ?')
        .get(run.conversationId)
    ).toEqual({
      project_id: 'worktree-1',
      home_workspace_root: 'C:/worktrees/project-1/worktree-1'
    })
    expect(h.starts).toHaveLength(1)
  })

  it('skips and says why when the busy folder is not a Git repository', async () => {
    const h = harness(at(16, 8), { occupants: busy, git: false })
    const schedule = h.service.create(daily())
    const run = await h.service.runNow(schedule.id)
    expect(run).toMatchObject({
      outcome: 'skipped',
      reason:
        'Skipped: “Fix the build” was working in the project folder, and it is not a Git repository, so the run could not start in a separate worktree.'
    })
    expect(h.starts).toHaveLength(0)
    expect(h.service.runs(schedule.id)[0]).toMatchObject({ outcome: 'skipped' })
  })

  it('skips while the previous run still waits for a free run slot', async () => {
    const queuedRunIds = new Set<string>()
    const h = harness(at(16, 8), { queuedRunIds })
    const schedule = h.service.create(daily())
    const first = await h.service.runNow(schedule.id)
    h.db.prepare('DELETE FROM agent_runs WHERE id = ?').run(first.agentRunId)
    queuedRunIds.add(first.agentRunId!)
    const second = await h.service.runNow(schedule.id)
    expect(second).toMatchObject({
      outcome: 'skipped',
      reason: 'Skipped: the previous run is still waiting for a free run slot.'
    })
  })
})
