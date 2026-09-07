import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRuntimeCoordinator } from '../services/agentRuntimeCoordinator'
import { ConversationRunPreparer } from '../services/conversationRunPreparer'
import { AgentRunStore } from '../services/agentRunStore'
import { AgentMessageMaterializer } from '../services/agentMessageMaterializer'
import { openApplicationDatabase } from '../bootstrap/database'
import { resolveProviderContext } from './providerRuntime'
import { AgentRunKernel } from '../services/agentRunKernel'
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
const collaborationInput = {
  id: 'fixture-run',
  threadId: 'fixture-thread',
  workspaceRoot: 'fixture-workspace',
  target,
  messages: [],
  projectInstructions: { content: '', sources: [] },
  collaborationInstructions: '',
  collaboration: { execute: vi.fn() }
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
  it('stops pending collaboration discovery durably and prevents delayed session/model setup', async () => {
    const { coordinator, store, kernel, tools } = fixture()
    const network = deferredFetch()
    const pending = coordinator.runCollaborationParticipant(collaborationInput)
    await network.started
    expect(network.fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
    expect(coordinator.hasActiveRuns()).toBe(true)
    expect(coordinator.stop('fixture-run')).toBe(true)
    expect(coordinator.stop('fixture-run')).toBe(true)
    expect(store.get('fixture-run')?.phase).toBe('cancelled')
    expect(await pending).toMatchObject({ phase: 'cancelled', toolRounds: 0, messages: [] })
    network.release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(tools.createSession).not.toHaveBeenCalled()
    expect(kernel.start).not.toHaveBeenCalled()
    expect(store.listAllEvents('fixture-run').map((event) => event.type)).toEqual([
      'run.started',
      'run.completed'
    ])
    expect(coordinator.hasActiveRuns()).toBe(false)
    expect(coordinator.stop('fixture-run')).toBe(false)
  })

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
    const pending = coordinator.runCollaborationParticipant(collaborationInput)
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
    const pending = coordinator.runCollaborationParticipant(collaborationInput)
    await network.started
    await coordinator.close()
    expect(await pending).toMatchObject({ phase: 'cancelled' })
    expect(tools.close).toHaveBeenCalledOnce()
    expect(coordinator.hasActiveRuns()).toBe(false)
    await expect(
      coordinator.runCollaborationParticipant({ ...collaborationInput, id: 'after-close' })
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

  it('transfers a synchronous stop during kernel registration to the newly active kernel', async () => {
    const { coordinator, store, tools } = fixture()
    tools.createSession.mockResolvedValue({
      catalog: () => ({ surface: 'collaboration', capabilities: [], webSearchEnabled: false }),
      router: { execute: vi.fn() }
    })
    const sampler = vi.fn().mockRejectedValue(new Error('model must not run'))
    const kernel = new AgentRunKernel(store, undefined, sampler, (event) => {
      if (event.type === 'run.started') expect(coordinator.stop(event.runId)).toBe(true)
    })
    Object.assign(coordinator, { kernel })
    const result = await coordinator.runCollaborationParticipant({
      ...collaborationInput,
      target: { ...target, contextLength: 32_768 }
    })
    expect(result.phase).toBe('cancelled')
    expect(store.get('fixture-run')?.phase).toBe('cancelled')
    expect(
      store.listAllEvents('fixture-run').filter((event) => event.type === 'run.completed')
    ).toHaveLength(1)
    expect(sampler).not.toHaveBeenCalled()
    expect(coordinator.hasActiveRuns()).toBe(false)
  })

  it('hands ordinary preparation to the kernel without duplicate run records or model turns', async () => {
    const { coordinator, store, tools } = fixture()
    tools.createSession.mockResolvedValue({
      catalog: () => ({ surface: 'collaboration', capabilities: [], webSearchEnabled: false }),
      router: { execute: vi.fn() }
    })
    const sampler = vi.fn(async () => ({
      result: { ok: true },
      turn: {
        content: 'Synthetic completion',
        thinking: '',
        thinkingBlocks: [],
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 2, doneReason: 'stop' }
      }
    }))
    Object.assign(coordinator, { kernel: new AgentRunKernel(store, undefined, sampler) })
    const result = await coordinator.runCollaborationParticipant({
      ...collaborationInput,
      target: { ...target, contextLength: 32_768 }
    })
    expect(result.phase).toBe('completed')
    expect(sampler).toHaveBeenCalledOnce()
    expect(
      store.listAllEvents('fixture-run').filter((event) => event.type === 'run.started')
    ).toHaveLength(1)
    expect(
      store.listAllEvents('fixture-run').filter((event) => event.type === 'run.completed')
    ).toHaveLength(1)
    expect(coordinator.hasActiveRuns()).toBe(false)
  })

  it('shutdown completes cleanup before surfacing cancellation observer failure', async () => {
    const { coordinator, tools, publish } = fixture()
    publish.mockImplementation(() => {
      throw new Error('synthetic observer failure')
    })
    const network = deferredFetch()
    const pending = coordinator.runCollaborationParticipant(collaborationInput)
    await network.started
    await expect(coordinator.close()).rejects.toThrow('synthetic observer failure')
    expect(await pending).toMatchObject({ phase: 'cancelled' })
    expect(tools.close).toHaveBeenCalledOnce()
    expect(coordinator.hasActiveRuns()).toBe(false)
    network.release()
  })

  it('drains a synchronous shutdown at kernel registration before closing tools', async () => {
    const { coordinator, store, tools } = fixture()
    tools.createSession.mockResolvedValue({
      catalog: () => ({ surface: 'collaboration', capabilities: [], webSearchEnabled: false }),
      router: { execute: vi.fn() }
    })
    tools.close.mockImplementation(async () => {
      expect(store.get('fixture-run')?.phase).toBe('cancelled')
    })
    let closed: Promise<void> | undefined
    const sampler = vi.fn().mockRejectedValue(new Error('model must not run'))
    Object.assign(coordinator, {
      kernel: new AgentRunKernel(store, undefined, sampler, (event) => {
        if (event.type === 'run.started') closed = coordinator.close()
      })
    })
    const pending = coordinator.runCollaborationParticipant({
      ...collaborationInput,
      target: { ...target, contextLength: 32_768 }
    })
    expect((await pending).phase).toBe('cancelled')
    expect(closed).toBeDefined()
    await closed
    expect(tools.close).toHaveBeenCalledOnce()
    expect(sampler).not.toHaveBeenCalled()
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
