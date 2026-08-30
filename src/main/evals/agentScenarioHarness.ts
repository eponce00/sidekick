import Database from 'better-sqlite3'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { applyDatabaseSchema } from '../bootstrap/database'
import { streamOpenAICompatibleChat } from '../providers/openAIStreamingClient'
import { toOpenAICompatibleMessages } from '../providers/providerRuntime'
import { AgentRunKernel, type AgentKernelProviderSampler } from '../services/agentRunKernel'
import { AgentRunStore } from '../services/agentRunStore'
import { AgentToolRuntime, type AgentCollaborationToolHandler } from '../services/agentToolRuntime'
import { CommandService } from '../services/commandService'
import { McpClientManager } from '../services/mcpClientManager'
import { ToolOutputStore } from '../services/toolOutputStore'
import { WorkspaceReadService } from '../services/workspaceReadService'
import { agentRunProfile } from '../../shared/agentToolCatalog'
import type { AgentRunEvent, AgentRunSurface } from '../../shared/agentRuntime'
import type {
  ProviderChatMessage,
  ProviderTarget,
  ProviderThinkingBlock,
  ProviderToolCall
} from '../../shared/providerRuntime'
import type { CollaborationKernelRunInput } from '../services/agentRuntimeCoordinator'
import type { ProviderKind } from '../../shared/providerRegistry'
import { AgentPlanService } from '../services/agentPlanService'

export interface AgentScenarioConfig {
  endpoint: string
  model: string
  headers: Record<string, string>
  providerKind?: ProviderKind
  maxOutputTokens?: number
  requestTimeoutMs?: number
}

export interface AgentKernelScenarioInput {
  workspaceRoot: string
  messages: ProviderChatMessage[]
  surface?: Extract<AgentRunSurface, 'conversation' | 'collaboration'>
  runId?: string
  threadId?: string
  maxToolRounds?: number
  planMode?: boolean
  autoApprovePlan?: boolean
  collaboration?: AgentCollaborationToolHandler
  beforeModelStep?: CollaborationKernelRunInput['beforeModelStep']
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
    let doneReason = 'stop'
    let tokensPerSecond: number | undefined
    const completion = await streamOpenAICompatibleChat(
      config.endpoint,
      {
        model: config.model,
        messages: toOpenAICompatibleMessages(request.messages),
        tools: request.tools?.length ? request.tools : undefined,
        max_tokens: Math.min(
          request.maxOutputTokens ?? config.maxOutputTokens ?? 4_096,
          config.maxOutputTokens ?? 8_192
        ),
        temperature: request.temperature ?? 0,
        ...(config.providerKind === 'openrouter' ? {} : { reasoning_effort: 'none' })
      },
      config.headers,
      (chunk) => {
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
          completionTokens,
          doneReason,
          ...(tokensPerSecond ? { tokensPerSecond } : {})
        },
        ...(completion.generationId ? { generationId: completion.generationId } : {})
      }
    }
  }
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
      new CommandService(this.db, join(runtimeRoot, 'command-outputs')),
      new ToolOutputStore(join(runtimeRoot, 'tool-outputs')),
      this.mcp
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
    const target: ProviderTarget = {
      providerKind: this.config.providerKind ?? 'litellm',
      model: this.config.model,
      editingDialect: 'structured-edit'
    }
    const planService = input.planMode
      ? new AgentPlanService(this.db, runId, this.config.model, this.config.model, 'planning')
      : null
    const session = await this.tools.createSession({
      runId,
      surface,
      workspaceRoot: input.workspaceRoot,
      webSearchEnabled: false,
      collaboration: input.collaboration,
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
        profile: agentRunProfile(session.catalog()),
        provider: this.config.providerKind ?? 'litellm',
        model: this.config.model,
        workspaceRoot: input.workspaceRoot,
        catalog: session.catalog,
        messages: input.messages,
        request: {
          target,
          maxOutputTokens: this.config.maxOutputTokens ?? 8_192,
          temperature: 0,
          purpose: 'conversation'
        },
        maxToolRounds: input.maxToolRounds ?? 60,
        permissionMode: 'full-access',
        toolRouter,
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

  collaborationRuntime(): {
    runCollaborationParticipant: (
      input: CollaborationKernelRunInput
    ) => Promise<AgentKernelScenarioResult>
    stop: (runId: string) => boolean
    events: (
      runId: string,
      afterSequence?: number
    ) => {
      run: ReturnType<AgentRunStore['get']>
      events: AgentRunEvent[]
      pendingInteractions: ReturnType<AgentRunStore['listPendingInteractions']>
    }
  } {
    return {
      runCollaborationParticipant: async (input) =>
        this.run({
          runId: input.id,
          threadId: input.threadId,
          workspaceRoot: input.workspaceRoot,
          surface: 'collaboration',
          messages: [
            {
              role: 'system',
              content: `You are running inside an isolated SideKick evaluation project. Use the available tools to do real work. Read existing files before editing them, keep all work inside the assigned project, verify the result, and communicate through the collaboration tools.\n\n${input.collaborationInstructions}`
            },
            ...(input.projectInstructions.content
              ? [
                  {
                    role: 'user',
                    content: `<project_instructions trust="app-loaded-project-instructions">\n${input.projectInstructions.content}\n</project_instructions>`
                  }
                ]
              : []),
            ...input.messages
          ],
          maxToolRounds: input.maxToolRounds,
          collaboration: input.collaboration,
          beforeModelStep: input.beforeModelStep,
          onEvent: input.onEvent,
          onWorkspaceWillMutate: input.onWorkspaceWillMutate
        }),
      stop: (runId) => this.stop(runId),
      events: (runId, afterSequence = 0) => ({
        run: this.store.get(runId),
        events: this.store.listEvents(runId, afterSequence, 10_000),
        pendingInteractions: this.store.listPendingInteractions(runId)
      })
    }
  }

  async close(options: { closeDatabase?: boolean } = {}): Promise<void> {
    for (const [runId, kernel] of this.activeKernels) kernel.stop(runId)
    await Promise.all([this.tools.close(), this.mcp.close()])
    if (options.closeDatabase !== false) this.db.close()
  }
}

export async function copyEvalFixture(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true })
  await fs.cp(source, destination, { recursive: true, force: true })
}
