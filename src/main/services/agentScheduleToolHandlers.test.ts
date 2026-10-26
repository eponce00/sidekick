import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentRunProfile, getAgentToolDefinitions } from '../../shared/agentToolCatalog'
import type { PermissionMode } from '../../shared/permissions'
import { AGENT_ACTIVE_SCHEDULE_LIMIT } from '../../shared/schedules'
import { applyDatabaseSchema } from '../bootstrap/database'
import { AgentRunKernel, type AgentKernelProviderSampler } from './agentRunKernel'
import { AgentRunStore } from './agentRunStore'
import { registerScheduleToolHandlers, type ScheduleToolChat } from './agentScheduleToolHandlers'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import type { AgentToolExecutionContext } from './agentToolRegistry'
import { ScheduleService, type ScheduledRunLauncher } from './scheduleService'
import { ScheduleStore } from './scheduleStore'

const MODEL = 'ollama:local/qwen3:8b'
const VALID = {
  name: 'Weekday check',
  prompt: 'Check the build of C:/demo and report any failure.',
  cadence: 'weekdays',
  time: '09:00'
}

let db: Database.Database
let service: ScheduleService
let chat: ScheduleToolChat

beforeEach(() => {
  db = new Database(':memory:')
  applyDatabaseSchema(db)
  db.prepare(
    "INSERT INTO projects (id, name, folder_path, created_at, updated_at) VALUES ('p1', 'demo', 'C:/demo', 1, 1)"
  ).run()
  db.prepare(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('thread-1', 'Planning', 1, 1)"
  ).run()
  service = new ScheduleService({
    store: new ScheduleStore(db),
    launcher: {} as ScheduledRunLauncher,
    onChange: () => undefined,
    permissionMode: () => 'full-access'
  })
  chat = { projectId: 'p1', modelId: MODEL, startedBySchedule: false }
})

function tools(permissionMode: PermissionMode = 'full-access') {
  const handlers = new AgentToolHandlerRegistry()
  const scheduleTools = registerScheduleToolHandlers(
    handlers,
    {
      schedules: service,
      models: () => [{ id: MODEL, name: 'Qwen 3 8B' }],
      projects: () => [{ id: 'p1', name: 'demo' }],
      chat: () => chat,
      settingMode: () => 'full-access'
    },
    { permissionMode }
  )
  return { handlers, scheduleTools }
}

/** Decides a call as the runtime does, then runs it as if the user approved. */
async function approvedCall(
  name: string,
  args: Record<string, unknown>,
  permissionMode?: PermissionMode
) {
  const { handlers, scheduleTools } = tools(permissionMode)
  const ids = { conversationId: 'thread-1', runId: 'run-1', toolCallId: `call-${Math.random()}` }
  const access = scheduleTools.requestedAccess(name, args, ids)
  const context = { ...ids, signal: new AbortController().signal } as AgentToolExecutionContext
  const result = await handlers.execute({ name, title: name, arguments: args, context })
  return { access, result }
}

describe('schedule tools', () => {
  it('stay out of the tool list until the schedules skill loads', () => {
    const names = (activeSkillIds: string[]) =>
      getAgentToolDefinitions({ surface: 'conversation', activeSkillIds }).map(
        (tool) => tool.function.name
      )
    expect(names([])).not.toContain('schedules_create')
    expect(names(['schedules'])).toEqual(
      expect.arrayContaining(['schedules_list', 'schedules_create', 'schedules_delete'])
    )
  })

  it('ask before saving even with full access, and save nothing when the user denies', async () => {
    const { handlers, scheduleTools } = tools()
    const create = (id: string): AgentKernelProviderSampler =>
      vi.fn(async () => ({
        result: { ok: true },
        turn: {
          content: '',
          thinking: '',
          thinkingBlocks: [],
          toolCalls: [{ id, function: { name: 'schedules_create', arguments: VALID } }],
          usage: { promptTokens: 1, completionTokens: 1, doneReason: 'stop' }
        }
      }))
    const samplers = [create('deny-me'), create('allow-me')]
    const done: AgentKernelProviderSampler = vi.fn(async () => ({
      result: { ok: true },
      turn: {
        content: 'Done',
        thinking: '',
        thinkingBlocks: [],
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, doneReason: 'stop' }
      }
    }))
    let turn = 0
    const store = new AgentRunStore(db)
    const kernel = new AgentRunKernel(store, undefined, (request, signal, onChunk) =>
      (samplers[turn++] ?? done)(request, signal, onChunk)
    )
    const catalog = {
      surface: 'conversation' as const,
      webSearchEnabled: false,
      activeSkillIds: ['schedules']
    }
    const running = kernel.start({
      id: 'run-1',
      threadId: 'thread-1',
      profile: agentRunProfile(catalog),
      provider: 'ollama',
      model: 'test-model',
      catalog,
      messages: [{ role: 'user', content: 'Every weekday at 9, check the build.' }],
      request: {
        target: { providerKind: 'ollama', model: 'test-model' },
        maxOutputTokens: 1_024,
        purpose: 'conversation'
      },
      maxToolRounds: 10,
      permissionMode: 'full-access',
      toolRouter: {
        execute: (name, args, context) =>
          handlers.execute({ name, title: name, arguments: args, context }),
        requestedAccess: (name, args, context) =>
          scheduleTools.requestedAccess(name, args, context),
        approvalPreview: (name, args, context) => handlers.preview(name, args, context)
      }
    })

    await vi.waitFor(() => expect(store.listPendingInteractions('run-1')).toHaveLength(1))
    const first = store.listPendingInteractions('run-1')[0]
    expect(first.request).toMatchObject({
      mode: 'full-access',
      preview: { quote: { text: VALID.prompt } }
    })
    expect(first.request.chatScope).toBeUndefined()
    kernel.resolveInteraction(first.id, { approved: false, decision: 'deny' })

    await vi.waitFor(() => expect(store.listPendingInteractions('run-1')).toHaveLength(1))
    expect(service.list()).toEqual([])
    const second = store.listPendingInteractions('run-1')[0]
    kernel.resolveInteraction(second.id, { approved: true, decision: 'allow_once' })

    expect((await running).phase).toBe('completed')
    expect(service.list()).toEqual([
      expect.objectContaining({
        name: VALID.name,
        createdBy: { kind: 'agent', conversationId: 'thread-1', conversationTitle: 'Planning' }
      })
    ])
  })

  it('save nothing for a change the runtime never put to the user', async () => {
    const { handlers } = tools()
    const context = {
      conversationId: 'thread-1',
      runId: 'run-1',
      toolCallId: 'unasked',
      signal: new AbortController().signal
    } as AgentToolExecutionContext
    const result = await handlers.execute({
      name: 'schedules_create',
      title: 'create',
      arguments: VALID,
      context
    })
    expect(result.status).toBe('denied')
    expect(service.list()).toEqual([])
  })

  it('refuse to create from a chat a schedule started', async () => {
    chat = { ...chat, startedBySchedule: true }
    const { access, result } = await approvedCall('schedules_create', VALID)
    expect(access).toBe('auto')
    expect(result.status).toBe('error')
    expect(service.list()).toEqual([])
  })

  it('never save a ceiling looser than the chat asking for it', async () => {
    const looser = await approvedCall(
      'schedules_create',
      { ...VALID, permission_ceiling: 'full-access' },
      'sensitive-only'
    )
    expect(looser.result.status).toBe('error')
    expect(service.list()).toEqual([])

    const defaulted = await approvedCall('schedules_create', VALID, 'sensitive-only')
    expect(defaulted.access).toBe('always')
    expect(service.list()).toEqual([
      expect.objectContaining({ permissionCeiling: 'sensitive-only' })
    ])
  })

  it.each([
    ['an unknown model', { model_id: 'missing' }],
    ['an unknown project', { project_id: 'missing' }],
    ['a time that is not HH:MM', { time: '9am' }],
    ['a weekly schedule without a day', { cadence: 'weekly' }],
    ['an unknown cadence', { cadence: 'monthly' }],
    ['an overlong prompt', { prompt: 'x'.repeat(20_001) }]
  ])('refuse %s without asking', async (_label, change) => {
    const { access, result } = await approvedCall('schedules_create', { ...VALID, ...change })
    expect(access).toBe('auto')
    expect(result.status).toBe('error')
    expect(service.list()).toEqual([])
  })

  it('cap the active schedules the agent made', async () => {
    for (let index = 0; index < AGENT_ACTIVE_SCHEDULE_LIMIT; index += 1) {
      service.create(
        {
          ...VALID,
          projectId: 'p1',
          modelId: MODEL,
          cadence: 'daily',
          hour: 9,
          minute: 0,
          weekday: 1,
          catchUp: true
        },
        { conversationId: 'thread-1' }
      )
    }
    const { result } = await approvedCall('schedules_create', VALID)
    expect(result.status).toBe('error')
    expect(service.list()).toHaveLength(AGENT_ACTIVE_SCHEDULE_LIMIT)
  })
})
