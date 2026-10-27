import Database from 'better-sqlite3'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { applyDatabaseSchema } from '../bootstrap/database'
import { streamOpenAICompatibleChat } from '../providers/openAIStreamingClient'
import {
  materializeProviderRequestMedia,
  toOpenAICompatibleMessages
} from '../providers/providerRuntime'
import { AgentRunKernel, type AgentKernelProviderSampler } from '../services/agentRunKernel'
import type {
  AgentKernelContextManager,
  StartAgentKernelRunInput
} from '../services/agentRunKernel'
import { AgentRunStore } from '../services/agentRunStore'
import { AgentToolRuntime } from '../services/agentToolRuntime'
import { CommandService } from '../services/commandService'
import { McpClientManager } from '../services/mcpClientManager'
import { ToolOutputStore } from '../services/toolOutputStore'
import { WorkspaceReadService } from '../services/workspaceReadService'
import { agentRunProfile } from '../../shared/agentToolCatalog'
import type { AgentCapability, AgentRunEvent, AgentRunSurface } from '../../shared/agentRuntime'
import type {
  ProviderChatMessage,
  ProviderChatRequest,
  ProviderTarget,
  ProviderThinkingBlock,
  ProviderToolCall
} from '../../shared/providerRuntime'
import type { ProviderKind } from '../../shared/providerRegistry'
import { AgentPlanService } from '../services/agentPlanService'
import type { NativeBrowserSessionService } from '../services/nativeBrowserSessionService'
import { editingDialectForModel, type EditingDialect } from '../../shared/workspaceMutations'

export interface AgentScenarioConfig {
  browser?: NativeBrowserSessionService
  /** Explicit shipped helper root, matching production CommandService environment wiring. */
  skillAssetsPath?: string
  shellIsolation?: boolean
  endpoint: string
  model: string
  headers: Record<string, string>
  providerKind?: ProviderKind
  maxOutputTokens?: number
  requestTimeoutMs?: number
  editingDialect?: EditingDialect
  /** Sampling temperature; null leaves it to the server, as production conversation runs do. */
  temperature?: number | null
  /** Run commands in a terminal, as the app does, instead of over pipes. */
  terminal?: boolean
}

export interface AgentKernelScenarioInput {
  contextManager?: AgentKernelContextManager
  capabilities?: readonly AgentCapability[]
  workspaceRoot: string
  messages: ProviderChatMessage[]
  webSearchEnabled?: boolean
  surface?: Extract<AgentRunSurface, 'conversation'>
  runId?: string
  threadId?: string
  /** Conversation message that receives the run's reply; durable history keys runs by it. */
  outputMessageId?: string
  maxToolRounds?: number
  planMode?: boolean
  autoApprovePlan?: boolean
  beforeModelStep?: StartAgentKernelRunInput['beforeModelStep']
  onEvent?: (event: AgentRunEvent) => void
  onWorkspaceWillMutate?: () => Promise<void>
  afterToolExecution?: (
    name: string,
    args: Record<string, unknown>,
    result: unknown
  ) => Promise<void>
}

export interface AgentKernelScenarioResult {
  runId: string
  phase: 'completed' | 'failed' | 'cancelled'
  content: string
  finalResponse?: string
  messages: ProviderChatMessage[]
  toolRounds: number
  error?: string
  events: AgentRunEvent[]
  toolNames: string[]
}

function liveSampler(config: AgentScenarioConfig): AgentKernelProviderSampler {
  return async (request, signal, onChunk) => {
    const startedAt = performance.now()
    let firstTokenMs: number | undefined
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(config.requestTimeoutMs ?? 120_000)
    ])
    let content = ''
    let thinking = ''
    const thinkingBlocks: ProviderThinkingBlock[] = []
    const toolCalls: ProviderToolCall[] = []
    let promptTokens = 0
    let completionTokens = 0
    let cachedPromptTokens: number | undefined
    let doneReason = 'stop'
    let tokensPerSecond: number | undefined
    const prepared = await materializeProviderRequestMedia(request)
    const completion = await streamOpenAICompatibleChat(
      config.endpoint,
      {
        model: config.model,
        messages: toOpenAICompatibleMessages(prepared.messages),
        tools: request.tools?.length ? request.tools : undefined,
        max_tokens: Math.min(
          request.maxOutputTokens ?? config.maxOutputTokens ?? 4_096,
          config.maxOutputTokens ?? 8_192
        ),
        temperature: config.temperature === null ? undefined : (request.temperature ?? 0)
        // Preserve server defaults, including production thinking. Never silently disable it.
      },
      config.headers,
      (chunk) => {
        if (
          firstTokenMs === undefined &&
          (chunk.message?.content || chunk.message?.thinking || chunk.message?.tool_calls?.length)
        )
          firstTokenMs = performance.now() - startedAt
        if (chunk.message?.content) content += chunk.message.content
        if (chunk.message?.thinking) thinking += chunk.message.thinking
        if (chunk.message?.thinking_blocks) thinkingBlocks.push(...chunk.message.thinking_blocks)
        for (const call of chunk.message?.tool_calls ?? []) {
          const existingIndex = toolCalls.findIndex(
            (candidate) =>
              (call.id && candidate.id === call.id) ||
              (call.index !== undefined && candidate.index === call.index)
          )
          if (existingIndex >= 0) toolCalls[existingIndex] = call
          else toolCalls.push(call)
        }
        if (chunk.prompt_eval_count !== undefined) promptTokens = chunk.prompt_eval_count
        if (chunk.eval_count !== undefined) completionTokens = chunk.eval_count
        if (chunk.cached_prompt_tokens !== undefined)
          cachedPromptTokens = chunk.cached_prompt_tokens
        if (chunk.done_reason) doneReason = chunk.done_reason
        if (chunk.predicted_per_second !== undefined) tokensPerSecond = chunk.predicted_per_second
        onChunk(chunk)
      },
      fetch,
      requestSignal
    )
    if (!completion.ok) {
      return {
        result: {
          ok: false,
          error: completion.error || 'Local model stream failed',
          status: completion.status
        },
        turn: {
          content,
          thinking,
          thinkingBlocks,
          toolCalls,
          usage: {
            promptTokens,
            ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
            completionTokens,
            doneReason: 'error'
          }
        }
      }
    }
    return {
      result: completion,
      turn: {
        content,
        thinking,
        thinkingBlocks,
        toolCalls: toolCalls.map((call) => ({ ...call, id: call.id || randomUUID() })),
        usage: {
          promptTokens,
          ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
          completionTokens,
          doneReason,
          providerDurationMs: performance.now() - startedAt,
          ...(firstTokenMs !== undefined ? { timeToFirstTokenMs: firstTokenMs } : {}),
          ...(tokensPerSecond ? { tokensPerSecond } : {})
        },
        ...(completion.generationId ? { generationId: completion.generationId } : {})
      }
    }
  }
}

/** Production-faithful provider serialization used by live scenario regression tests. */
export async function serializeAgentScenarioMessages(
  request: ProviderChatRequest
): Promise<Array<Record<string, unknown>>> {
  const prepared = await materializeProviderRequestMedia(request)
  return toOpenAICompatibleMessages(prepared.messages)
}

export class AgentScenarioHarness {
  readonly db: Database.Database
  private readonly mcp = new McpClientManager()
  private readonly tools: AgentToolRuntime
  private readonly store: AgentRunStore
  private readonly activeKernels = new Map<string, AgentRunKernel>()

  constructor(
    private readonly runtimeRoot: string,
    private readonly config: AgentScenarioConfig,
    db?: Database.Database
  ) {
    this.db = db ?? new Database(':memory:')
    if (!db) applyDatabaseSchema(this.db)
    this.store = new AgentRunStore(this.db)
    this.tools = new AgentToolRuntime(
      this.db,
      new WorkspaceReadService(),
      new CommandService(
        this.db,
        join(runtimeRoot, 'command-outputs'),
        undefined,
        config.skillAssetsPath,
        () => config.shellIsolation === true,
        { terminalEnabled: () => config.terminal === true }
      ),
      new ToolOutputStore(join(runtimeRoot, 'tool-outputs')),
      this.mcp,
      undefined,
      undefined,
      config.browser
    )
  }

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(join(this.runtimeRoot, 'command-outputs'), { recursive: true }),
      fs.mkdir(join(this.runtimeRoot, 'tool-outputs'), { recursive: true })
    ])
  }

  async run(input: AgentKernelScenarioInput): Promise<AgentKernelScenarioResult> {
    const runId = input.runId ?? randomUUID()
    const surface = input.surface ?? 'conversation'
    const editingDialect =
      this.config.editingDialect ??
      editingDialectForModel({
        providerKind: this.config.providerKind ?? 'litellm',
        model: this.config.model
      })
    const target: ProviderTarget = {
      providerKind: this.config.providerKind ?? 'litellm',
      model: this.config.model,
      editingDialect
    }
    const planService = input.planMode
      ? new AgentPlanService(this.db, runId, this.config.model, this.config.model, 'planning')
      : null
    const session = await this.tools.createSession({
      runId,
      surface,
      workspaceRoot: input.workspaceRoot,
      capabilities: input.capabilities,
      browserEnabled: Boolean(this.config.browser),
      webSearchEnabled: input.webSearchEnabled === true,
      editingDialect,
      plan: planService
        ? {
            stage: () => planService.stage(),
            complete: (completion) => planService.complete(completion)
          }
        : undefined,
      onWorkspaceWillMutate: input.onWorkspaceWillMutate
    })
    const toolRouter = input.afterToolExecution
      ? {
          ...session.router,
          execute: async (...args: Parameters<typeof session.router.execute>) => {
            const result = await session.router.execute(...args)
            await input.afterToolExecution!(args[0], args[1], result)
            return result
          }
        }
      : session.router
    const kernel = new AgentRunKernel(this.store, undefined, liveSampler(this.config), (event) => {
      input.onEvent?.(event)
      if (
        input.autoApprovePlan &&
        event.type === 'question.requested' &&
        event.payload.kind === 'plan_approval'
      ) {
        const interactionId = String(event.payload.interactionId || '')
        const request = (event.payload.request ?? {}) as Record<string, unknown>
        setTimeout(() => {
          if (!interactionId || !this.store.listPendingInteractions(runId).length) return
          kernel.resolveInteraction(interactionId, {
            action: 'approve',
            approved: true,
            ...(request.revision ? { revision: request.revision } : {})
          })
        }, 0)
      }
    })
    this.activeKernels.set(runId, kernel)
    try {
      const result = await kernel.start({
        id: runId,
        threadId: input.threadId ?? runId,
        outputMessageId: input.outputMessageId,
        profile: agentRunProfile(session.catalog()),
        provider: this.config.providerKind ?? 'litellm',
        model: this.config.model,
        workspaceRoot: input.workspaceRoot,
        catalog: session.catalog,
        messages: input.messages,
        request: {
          target,
          maxOutputTokens: this.config.maxOutputTokens ?? 8_192,
          temperature:
            this.config.temperature === null ? undefined : (this.config.temperature ?? 0),
          purpose: 'conversation'
        },
        maxToolRounds: input.maxToolRounds ?? 60,
        permissionMode: 'full-access',
        toolRouter,
        contextManager: input.contextManager,
        verificationController: session.verificationController,
        planController: planService
          ? {
              stage: () => planService.stage(),
              enter: async () => {
                planService.enter()
                return {
                  profile: agentRunProfile(session.catalog()),
                  provider: this.config.providerKind ?? 'litellm',
                  model: this.config.model,
                  request: {
                    target,
                    maxOutputTokens: this.config.maxOutputTokens ?? 8_192,
                    temperature: 0,
                    purpose: 'conversation'
                  }
                }
              },
              prepareReview: async (plan) => planService.prepareReview(plan),
              approve: async (revision) => {
                planService.approve(revision)
                return {
                  profile: agentRunProfile(session.catalog()),
                  provider: this.config.providerKind ?? 'litellm',
                  model: this.config.model,
                  request: {
                    target,
                    maxOutputTokens: this.config.maxOutputTokens ?? 8_192,
                    temperature: 0,
                    purpose: 'conversation'
                  },
                  revision
                }
              },
              revise: async (revision) => planService.revise(revision),
              keep: async (revision) => planService.keep(revision),
              afterTerminalTurn: async () => planService.afterTerminalTurn()
            }
          : undefined,
        beforeModelStep: input.beforeModelStep
      })
      const events = this.store.listEvents(runId, 0, 10_000)
      return {
        ...result,
        events,
        toolNames: events
          .filter((event) => event.type === 'tool.completed')
          .map((event) => String(event.payload.name || ''))
          .filter(Boolean)
      }
    } finally {
      this.activeKernels.delete(runId)
    }
  }

  stop(runId: string): boolean {
    return this.activeKernels.get(runId)?.stop(runId) ?? false
  }

  async close(options: { closeDatabase?: boolean } = {}): Promise<void> {
    for (const [runId, kernel] of this.activeKernels) kernel.stop(runId)
    await Promise.all([this.tools.close(), this.mcp.close()])
    if (options.closeDatabase !== false) this.db.close()
  }

  browserState(threadId: string) {
    return this.tools.browser?.workspaceState(threadId)
  }
}

export async function copyEvalFixture(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true })
  await fs.cp(source, destination, { recursive: true, force: true })
}

/** Run an evaluation in a unique temporary root and remove every generated artifact afterward. */
export async function withIsolatedEvalRoot<T>(
  prefix: string,
  operation: (root: string) => Promise<T>
): Promise<T> {
  const root = await fs.mkdtemp(join(tmpdir(), prefix))
  try {
    return await operation(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
