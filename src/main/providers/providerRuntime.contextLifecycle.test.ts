import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRuntimeCoordinator } from '../services/agentRuntimeCoordinator'
import { WorkspaceOccupancy } from '../services/workspaceOccupancy'
import { RunSlots } from '../services/runSlots'
import { ConversationRunPreparer } from '../services/conversationRunPreparer'
import { AgentRunStore } from '../services/agentRunStore'
import { AgentMessageMaterializer } from '../services/agentMessageMaterializer'
import { openApplicationDatabase } from '../bootstrap/database'
import { resolveProviderContext } from './providerRuntime'
import { ConversationGoalStore } from '../services/conversationGoalStore'
import type { PreparedConversationAgentRun } from '../services/conversationRunPreparer'

const provider = vi.hoisted(() => ({ type: 'openai-compatible', preset: 'generic' }))
import type { StartConversationAgentRunInput } from '../../shared/agentRunApi'

vi.mock('./providerResolver', () => ({
  resolveProviderInstance: () => ({
    id: 'fixture',
    name: 'Fixture',
    type: provider.type,
    preset: provider.preset,
    enabled: true,
    baseUrl: 'https://fixture.invalid/v1',
    modelSource: 'discover',
    models: []
  }),
  requireProviderApiKey: vi.fn(),
  resolveProviderDraft: vi.fn(),
  resolveProviderInstanceById: vi.fn()
}))

const databases: ReturnType<typeof openApplicationDatabase>[] = []
afterEach(() => {
  provider.type = 'openai-compatible'
  provider.preset = 'generic'
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
})
const target = {
  providerKind: 'openai-compatible' as const,
  providerInstanceId: 'fixture',
  model: 'fixture'
}
const conversationInput: StartConversationAgentRunInput = {
  id: 'fixture-run',
  conversationId: 'fixture-thread',
  assistantMessageId: 'fixture-message',
  model: { id: 'fixture', name: 'fixture', provider: 'lmstudio', providerKind: 'openai-compatible' }
}

function fixture() {
  const db = openApplicationDatabase(':memory:')
  databases.push(db)
  db.exec(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('fixture-thread', 'Fixture', 1, 1)"
  )
  const store = new AgentRunStore(db)
  const coordinator = Object.create(AgentRuntimeCoordinator.prototype) as AgentRuntimeCoordinator
  const createSession = vi.fn().mockRejectedValue(new Error('unexpected session setup'))
  const kernel = {
    stop: vi.fn(() => false),
    start: vi.fn(),
    hasActiveRuns: vi.fn(() => false),
    stopAll: vi.fn(async () => {})
  }
  const publish = vi.fn()
  const tools = { createSession, cancelRun: vi.fn(), close: vi.fn(async () => {}) }
  Object.assign(coordinator, {
    db,
    store,
    messages: new AgentMessageMaterializer(db, store),
    preparations: new Map(),
    activeConversations: new Map(),
    observers: new Map(),
    settings: () => ({}),
    tools,
    kernel,
    publishExternal: publish,
    commands: { cancelAll: vi.fn() },
    mcp: { close: vi.fn(async () => {}) },
    goals: new ConversationGoalStore(db),
    occupancy: new WorkspaceOccupancy(),
    runSlots: new RunSlots(() => 4),
    leases: new Map(),
    skillAssetsPath: () => 'fixture-assets'
  })
  return { coordinator, db, store, kernel, tools, publish }
}

function deferredFetch() {
  const releases: Array<(response: Response) => void> = []
  let requested!: () => void
  const started = new Promise<void>((resolve) => {
    requested = resolve
  })
  const fetch = vi.fn((_url: unknown, _options?: RequestInit) => {
    requested()
    return new Promise<Response>((resolve) => {
      releases.push(resolve)
    })
  })
  vi.stubGlobal('fetch', fetch)
  return {
    started,
    fetch,
    release: () => {
      for (const resolve of releases.splice(0)) resolve(new Response(JSON.stringify({ data: [] })))
    }
  }
}

function contextOnlyPreparation() {
  return vi
    .spyOn(ConversationRunPreparer.prototype, 'prepare')
    .mockImplementation(async (_input, _capture, signal) => {
      await resolveProviderContext(target, signal)
      throw new Error('unexpected preparation continuation')
    })
}

describe('provider context discovery before kernel registration', () => {
  it('materializes one cancelled conversation and rejects overlapping preparation', async () => {
    const { coordinator, store, db, kernel } = fixture()
    const network = deferredFetch()
    contextOnlyPreparation()
    const pending = coordinator.startConversation(conversationInput)
    await network.started
    await expect(
      coordinator.startConversation({ ...conversationInput, id: 'second-run' })
    ).rejects.toThrow('already has an active run')
    await expect(coordinator.startConversation(conversationInput)).rejects.toThrow('already exists')
    expect(coordinator.stop('fixture-run')).toBe(true)
    expect(await pending).toMatchObject({ phase: 'cancelled' })
    network.release()
    expect(kernel.start).not.toHaveBeenCalled()
    expect(store.listAllEvents('fixture-run').map((event) => event.type)).toEqual([
      'run.started',
      'run.completed',
      'run.finalized'
    ])
    expect(db.prepare('SELECT id, run_id FROM messages').all()).toEqual([
      { id: 'fixture-message', run_id: 'fixture-run' }
    ])
  })

  it('settles and cleans up despite cancellation observer exceptions', async () => {
    const { coordinator, store, publish } = fixture()
    publish.mockImplementation(() => {
      throw new Error('synthetic observer failure')
    })
    const network = deferredFetch()
    contextOnlyPreparation()
    const pending = coordinator.startConversation(conversationInput)
    await network.started
    expect(() => coordinator.stop('fixture-run')).toThrow('synthetic observer failure')
    expect(await pending).toMatchObject({ phase: 'cancelled' })
    network.release()
    expect(store.get('fixture-run')?.phase).toBe('cancelled')
    expect(coordinator.hasActiveRuns()).toBe(false)
  })

  it('shutdown cancels pending discovery without waiting for a signal-ignoring fetch', async () => {
    const { coordinator, tools } = fixture()
    const network = deferredFetch()
    contextOnlyPreparation()
    const pending = coordinator.startConversation(conversationInput)
    await network.started
    await coordinator.close()
    expect(await pending).toMatchObject({ phase: 'cancelled' })
    expect(tools.close).toHaveBeenCalledOnce()
    expect(coordinator.hasActiveRuns()).toBe(false)
    await expect(
      coordinator.startConversation({ ...conversationInput, id: 'after-close' })
    ).rejects.toThrow('closing')
    network.release()
  })

  it('releases reservations on preparation failure without relabeling it cancellation', async () => {
    const { coordinator, store } = fixture()
    const prepare = vi
      .spyOn(ConversationRunPreparer.prototype, 'prepare')
      .mockRejectedValue(new Error('synthetic preparation failure'))
    await expect(coordinator.startConversation(conversationInput)).rejects.toThrow(
      'synthetic preparation failure'
    )
    await expect(coordinator.startConversation(conversationInput)).rejects.toThrow(
      'synthetic preparation failure'
    )
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(store.get('fixture-run')).toBeNull()
    expect(coordinator.hasActiveRuns()).toBe(false)
  })

  it('shutdown completes cleanup before surfacing cancellation observer failure', async () => {
    const { coordinator, tools, publish } = fixture()
    publish.mockImplementation(() => {
      throw new Error('synthetic observer failure')
    })
    const network = deferredFetch()
    contextOnlyPreparation()
    const pending = coordinator.startConversation(conversationInput)
    await network.started
    await expect(coordinator.close()).rejects.toThrow('synthetic observer failure')
    expect(await pending).toMatchObject({ phase: 'cancelled' })
    expect(tools.close).toHaveBeenCalledOnce()
    expect(coordinator.hasActiveRuns()).toBe(false)
    network.release()
  })

  it('passes cancellation through the real conversation preparer context-discovery awaits', async () => {
    const { coordinator, tools, kernel } = fixture()
    tools.createSession.mockResolvedValue({
      catalog: () => ({ surface: 'conversation', capabilities: [], webSearchEnabled: false }),
      router: { execute: vi.fn() }
    })
    const network = deferredFetch()
    const pending = coordinator.startConversation({
      ...conversationInput,
      model: { ...conversationInput.model, supportsTools: false }
    })
    await network.started
    expect(coordinator.stop('fixture-run')).toBe(true)
    expect((await pending).phase).toBe('cancelled')
    network.release()
    expect(kernel.start).not.toHaveBeenCalled()
  })

  it.each(['pauseGoal', 'clearGoal'] as const)(
    '%s cancels only preparation reserved for that goal',
    async (operation) => {
      const { coordinator, kernel } = fixture()
      const goal = coordinator.createGoal({
        conversationId: 'fixture-thread',
        objective: 'Synthetic objective'
      })
      contextOnlyPreparation()
      const network = deferredFetch()
      const pending = coordinator.startConversation(conversationInput)
      await network.started
      coordinator[operation](goal.id)
      expect((await pending).phase).toBe('cancelled')
      network.release()
      expect(kernel.start).not.toHaveBeenCalled()
      expect(coordinator.hasActiveRuns()).toBe(false)
    }
  )

  it('releases the active-conversation entry when kernel.start throws synchronously', async () => {
    const { coordinator, kernel } = fixture()
    vi.spyOn(ConversationRunPreparer.prototype, 'prepare').mockResolvedValue({
      workspaceRoot: null,
      kernelInput: {}
    } as PreparedConversationAgentRun)
    kernel.start.mockImplementation(() => {
      throw new Error('synthetic synchronous start failure')
    })
    await expect(coordinator.startConversation(conversationInput)).rejects.toThrow(
      'synthetic synchronous start failure'
    )
    expect(
      (coordinator as unknown as { activeConversations: Map<string, unknown> }).activeConversations
        .size
    ).toBe(0)
    await expect(coordinator.startConversation(conversationInput)).rejects.toThrow(
      'synthetic synchronous start failure'
    )
    expect(coordinator.hasActiveRuns()).toBe(false)
  })

  it.each(['generic', 'lmstudio', 'llamacpp', 'litellm', 'ollama'])(
    'aborts %s metadata without starting fallback requests',
    async (kind) => {
      provider.type = ['generic', 'lmstudio'].includes(kind) ? 'openai-compatible' : kind
      provider.preset = kind
      const network = deferredFetch()
      const controller = new AbortController()
      const pending = resolveProviderContext(target, controller.signal)
      await network.started
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(network.fetch.mock.calls[0][1]?.signal).toBe(controller.signal)
      network.release()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(network.fetch).toHaveBeenCalledOnce()
    }
  )
})

describe('workspace guard at run start', () => {
  function inSharedProject(db: ReturnType<typeof openApplicationDatabase>): void {
    db.exec(`
      INSERT INTO projects (id, name, folder_path, created_at, updated_at)
        VALUES ('shared-project', 'Shared', '${process.cwd().replaceAll("'", "''")}', 1, 1);
      UPDATE conversations SET project_id = 'shared-project' WHERE id = 'fixture-thread';
      INSERT INTO conversations (id, title, created_at, updated_at, project_id)
        VALUES ('other-thread', 'Other chat', 1, 1, 'shared-project'),
               ('third-thread', 'Third chat', 1, 1, 'shared-project');
    `)
  }
  const other = {
    ...conversationInput,
    id: 'other-run',
    conversationId: 'other-thread',
    assistantMessageId: 'other-message'
  }

  it('refuses a second writer in a busy folder until it is free or shared', async () => {
    const { coordinator, db } = fixture()
    inSharedProject(db)
    const network = deferredFetch()
    contextOnlyPreparation()
    const pending = coordinator.startConversation(conversationInput)
    await network.started

    expect(coordinator.workspaceOccupants('other-thread').map(({ title }) => title)).toEqual([
      'Fixture'
    ])
    await expect(coordinator.startConversation(other)).rejects.toThrow(
      'Another agent is already working in this folder (“Fixture”)'
    )
    const research = coordinator.startConversation({ ...other, id: 'research', mode: 'research' })
    const shared = coordinator.startConversation({
      ...other,
      id: 'shared',
      conversationId: 'third-thread',
      assistantMessageId: 'third-message',
      workspaceSharing: 'allow'
    })
    // Both got past the guard and are now waiting on the provider like the first run.
    coordinator.stop('research')
    coordinator.stop('shared')
    coordinator.stop('fixture-run')
    for (const run of [pending, research, shared])
      await expect(run).resolves.toMatchObject({ phase: 'cancelled' })
    network.release()

    expect(coordinator.workspaceOccupants('other-thread')).toEqual([])
  })

  it('frees the folder when preparation fails', async () => {
    const { coordinator, db } = fixture()
    inSharedProject(db)
    vi.spyOn(ConversationRunPreparer.prototype, 'prepare').mockRejectedValue(
      new Error('synthetic preparation failure')
    )
    await expect(coordinator.startConversation(conversationInput)).rejects.toThrow(
      'synthetic preparation failure'
    )
    expect(coordinator.workspaceOccupants('other-thread')).toEqual([])
  })
})

describe('run slots at run start', () => {
  function withOneSlot() {
    const created = fixture()
    created.db.exec(
      "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('other-thread', 'Other', 1, 1)"
    )
    Object.assign(created.coordinator, { runSlots: new RunSlots(() => 1) })
    return created
  }
  const other = {
    ...conversationInput,
    id: 'other-run',
    conversationId: 'other-thread',
    assistantMessageId: 'other-message'
  }

  it('queues a second run until the first frees its slot', async () => {
    const { coordinator } = withOneSlot()
    const network = deferredFetch()
    const prepare = contextOnlyPreparation()
    const first = coordinator.startConversation(conversationInput)
    await network.started
    const second = coordinator.startConversation(other)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(
      coordinator.queuedRuns().map(({ runId, conversationId }) => [runId, conversationId])
    ).toEqual([['other-run', 'other-thread']])
    expect(prepare).toHaveBeenCalledTimes(1)

    coordinator.stop('fixture-run')
    await expect(first).resolves.toMatchObject({ phase: 'cancelled' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(coordinator.queuedRuns()).toEqual([])
    expect(prepare).toHaveBeenCalledTimes(2)
    coordinator.stop('other-run')
    await expect(second).resolves.toMatchObject({ phase: 'cancelled' })
    network.release()
  })

  it('returns at once from a background start that has to wait, and can be stopped while queued', async () => {
    const { coordinator, store } = withOneSlot()
    const network = deferredFetch()
    contextOnlyPreparation()
    const first = coordinator.startConversation(conversationInput)
    await network.started
    await expect(coordinator.startConversationInBackground(other)).resolves.toEqual({
      queued: true
    })
    expect(coordinator.stop('other-run')).toBe(true)
    expect(store.get('other-run')?.phase).toBe('cancelled')
    coordinator.stop('fixture-run')
    await first
    network.release()
  })

  it('records why a background start failed on the run itself', async () => {
    const { coordinator, store } = withOneSlot()
    vi.spyOn(ConversationRunPreparer.prototype, 'prepare').mockRejectedValue(
      new Error('synthetic preparation failure')
    )
    await coordinator.startConversationInBackground(other).catch(() => undefined)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(store.get('other-run')).toMatchObject({
      phase: 'failed',
      error: { message: 'synthetic preparation failure' }
    })
    expect(coordinator.runSlots.inUse().global).toBe(0)
  })

  it('gives the slot back while a run waits for approval', async () => {
    const { coordinator } = withOneSlot()
    const lease = await coordinator.runSlots.acquire({
      runId: 'waiting-run',
      providerKey: 'fixture',
      providerLimit: 1,
      signal: new AbortController().signal
    })
    ;(coordinator as unknown as { leases: Map<string, unknown> }).leases.set('waiting-run', lease)
    ;(coordinator as unknown as { publishEvent: (event: unknown) => void }).publishEvent({
      id: 'event',
      runId: 'waiting-run',
      sequence: 1,
      type: 'run.phase',
      payload: { phase: 'awaiting_permission' },
      timestamp: 1
    })
    expect(lease.held).toBe(false)
    expect(coordinator.runSlots.inUse().global).toBe(0)
  })
})
