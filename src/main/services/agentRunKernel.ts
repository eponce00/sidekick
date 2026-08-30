import { randomUUID } from 'crypto'
import {
  getAgentToolDefinitions,
  getAgentToolEntry,
  presentAgentToolCall,
  presentAgentToolResult,
  type AgentToolCatalogOptions
} from '../../shared/agentToolCatalog'
import {
  toolExecutionFailed,
  toolExecutionSucceeded,
  type AgentRunEvent,
  type AgentRunPhase,
  type AgentToolCall,
  type PendingAgentInteraction,
  type StartAgentRunInput,
  type ToolExecutionResult
} from '../../shared/agentRuntime'
import type {
  ProviderChatMessage,
  ProviderChatRequest,
  ProviderStreamChunk,
  ProviderStreamResult,
  ProviderThinkingBlock,
  ProviderToolCall
} from '../../shared/providerRuntime'
import { validateProviderTranscript } from '../../shared/providerTranscript'
import { providerContextWindowError } from '../../shared/providerErrors'
import { normalizeCompletedToolInput } from '../../shared/toolCalls'
import {
  resolvePermissionPolicy,
  type PermissionMode,
  type RequestedAccess
} from '../../shared/permissions'
import { commandCanRunWithoutApproval } from './commandPermissionClassifier'
import { streamProviderChat } from '../providers/providerRuntime'
import { previewToolCallArguments } from '../providers/toolCallPreview'
import { AgentRunStore } from './agentRunStore'
import {
  AgentToolRegistry,
  prepareAgentToolCall,
  validatePreparedAgentToolCall,
  type AgentToolExecutionContext,
  type AgentToolExecutor
} from './agentToolRegistry'
import { AgentToolRecoveryController } from './agentToolRecoveryController'
import type { VerificationTerminalDecision } from '../../shared/verification'
import type { AgentPlanReview, AgentPlanStage } from '../../shared/agentPlans'
import type { AgentPlanTerminalDecision } from './agentPlanService'
import { abortablePromise } from './abortablePromise'

export interface AgentKernelModelTurn {
  content: string
  thinking: string
  thinkingBlocks: ProviderThinkingBlock[]
  toolCalls: ProviderToolCall[]
  usage: {
    promptTokens: number
    cachedPromptTokens?: number
    completionTokens: number
    doneReason: string
    tokensPerSecond?: number
    timeToFirstTokenMs?: number
  }
  generationId?: string
}

export type AgentKernelProviderSampler = (
  request: ProviderChatRequest,
  signal: AbortSignal,
  onChunk: (chunk: ProviderStreamChunk) => void
) => Promise<{ result: ProviderStreamResult; turn: AgentKernelModelTurn }>

export interface AgentKernelToolRouter {
  execute: (
    name: string,
    args: Record<string, unknown>,
    context: AgentToolExecutionContext
  ) => Promise<unknown>
  title?: (name: string, args: Record<string, unknown>) => string
  safeArguments?: (name: string, args: Record<string, unknown>) => Record<string, unknown>
}

export interface AgentKernelContextManager {
  shouldCompact(messages: ProviderChatMessage[], tools: readonly unknown[]): boolean
  observeUsage?(
    messages: ProviderChatMessage[],
    tools: readonly unknown[],
    promptTokens: number
  ): void
  compact(
    messages: ProviderChatMessage[],
    tools: readonly unknown[],
    signal: AbortSignal
  ): Promise<{
    messages: ProviderChatMessage[]
    compacted: boolean
    details?: Record<string, unknown>
  }>
}

export interface AgentKernelRuntimeTransition {
  profile: StartAgentRunInput['profile']
  provider: string
  model: string
  request: Omit<ProviderChatRequest, 'messages' | 'tools'>
  contextManager?: AgentKernelContextManager
  /** Replaces the canonical system prompt when models or execution phases change. */
  systemPrompt?: string
  revision?: string
}

export interface AgentKernelPlanController {
  stage: () => AgentPlanStage
  enter: () => Promise<AgentKernelRuntimeTransition>
  prepareReview: (plan: unknown) => Promise<AgentPlanReview>
  approve: (revision: string) => Promise<AgentKernelRuntimeTransition>
  revise: (revision: string) => Promise<AgentPlanReview>
  keep: (revision: string) => Promise<AgentPlanReview>
  afterTerminalTurn: () => Promise<AgentPlanTerminalDecision>
}

export interface StartAgentKernelRunInput extends StartAgentRunInput {
  catalog: AgentToolCatalogOptions | (() => AgentToolCatalogOptions)
  messages: ProviderChatMessage[]
  request: Omit<ProviderChatRequest, 'messages' | 'tools'>
  maxToolRounds: number
  permissionMode: PermissionMode
  toolRouter: AgentKernelToolRouter
  contextManager?: AgentKernelContextManager
  /** Injects newly arrived external events at safe provider boundaries. */
  beforeModelStep?: (
    messages: ProviderChatMessage[],
    signal: AbortSignal,
    toolRounds: number
  ) => Promise<ProviderChatMessage[]>
  /** Keeps a durable objective alive after an otherwise terminal model turn. */
  goalController?: {
    onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void
    afterTerminalTurn: (input: {
      finalResponse: string
      messages: ProviderChatMessage[]
      toolRounds: number
    }) => Promise<{ continue: boolean; prompt?: string }>
  }
  /** Requires one bounded, evidence-based verification pass before workspace-changing runs finish. */
  verificationController?: {
    afterTerminalTurn: () => Promise<VerificationTerminalDecision>
  }
  /** Owns read-only planning, revisioned review, and the approved Plan-to-Act transition. */
  planController?: AgentKernelPlanController
}

export interface AgentKernelRunResult {
  runId: string
  phase: Extract<AgentRunPhase, 'completed' | 'failed' | 'cancelled'>
  /** All assistant text emitted across the run, used by the full transcript. */
  content: string
  /** Text from the terminal model turn only, suitable for a public completion. */
  finalResponse?: string
  thinking: string
  messages: ProviderChatMessage[]
  toolRounds: number
  error?: string
}

interface ActiveKernelRun {
  controller: AbortController
  promise: Promise<AgentKernelRunResult>
}

interface PendingResolver {
  runId: string
  resolve: (interaction: PendingAgentInteraction) => void
}

class AgentToolLoopError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentToolLoopError'
  }
}

const RESEARCH_SOURCE_TOOLS = new Set(['web_search', 'web_fetch'])
const RESEARCH_SOURCE_GUARD = `<sidekick_research_guard trust="app-policy">
This research report cannot finish without attempting source retrieval. Use web_search to discover relevant sources and web_fetch to verify the material claims. If retrieval fails, report that limitation explicitly. Do not repeat the unverified answer from the previous turn.
</sidekick_research_guard>`
const RESEARCH_UNVERIFIED_RESPONSE =
  'I couldn’t complete a verified research report because the selected model did not use the available web research tools. Try again with a tool-capable model.'

const TOOL_PREVIEW_FIELDS = new Set([
  'file_path',
  'path',
  'title',
  'type',
  'query',
  'url',
  'regex',
  'sub_path',
  'glob',
  'seconds',
  'reason',
  'replace_all',
  'background'
])

function parsedToolArguments(call: ProviderToolCall): {
  arguments: Record<string, unknown>
} {
  const raw = call.function.arguments
  if (!raw) return { arguments: {} }
  if (typeof raw === 'object') return { arguments: raw }
  const completed = normalizeCompletedToolInput(raw)
  if (completed.recovered) {
    return { arguments: completed.arguments as Record<string, unknown> }
  }
  return {
    arguments:
      typeof completed.arguments === 'string'
        ? (JSON.parse(completed.arguments) as Record<string, unknown>)
        : completed.arguments
  }
}

function objectArguments(call: ProviderToolCall): Record<string, unknown> {
  return parsedToolArguments(call).arguments
}

function withToolGuard(result: ToolExecutionResult, guard: string): ToolExecutionResult {
  return {
    ...result,
    modelContent: `${result.modelContent}\n${guard}`,
    ...(result.error
      ? {
          error: {
            ...result.error,
            recovery: [
              result.error.recovery,
              'SideKick detected repeated behavior; do not repeat the unchanged approach.'
            ]
              .filter(Boolean)
              .join(' ')
          }
        }
      : {})
  }
}

function safePreview(call: ProviderToolCall): Record<string, unknown> {
  const raw = call.function.arguments
  if (typeof raw === 'string') return previewToolCallArguments(raw)
  const preview: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (TOOL_PREVIEW_FIELDS.has(key)) preview[key] = value
  }
  return preview
}

/**
 * Providers use several spellings for an output-token stop. Tool arguments from
 * such a turn are unsafe even when their JSON happens to parse: the model may
 * have stopped at a syntactically valid but semantically incomplete boundary.
 */
function toolBatchMayBeTruncated(doneReason: string): boolean {
  const normalized = doneReason.trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')
  return (
    normalized === 'length' ||
    normalized === 'max_tokens' ||
    normalized === 'max_output_tokens' ||
    normalized === 'token_limit' ||
    normalized === 'model_length'
  )
}

function uniqueToolCallIds(calls: readonly ProviderToolCall[]): ProviderToolCall[] {
  const seen = new Set<string>()
  return calls.map((call, index) => {
    const base = call.id?.trim() || `tool_call_${index}`
    let id = base
    let suffix = 2
    while (seen.has(id)) id = `${base}_${suffix++}`
    seen.add(id)
    return id === call.id ? call : { ...call, id }
  })
}

function mergeToolCalls(existing: ProviderToolCall[], incoming: ProviderToolCall[]): void {
  for (const call of incoming) {
    const index = existing.findIndex(
      (candidate) =>
        (call.id && candidate.id === call.id) ||
        (call.index !== undefined && candidate.index === call.index)
    )
    if (index >= 0) existing[index] = call
    else existing.push(call)
  }
}

function defaultToolTitle(name: string, args: Record<string, unknown>): string {
  if (name === 'shell') return String(args.title || 'Run command')
  if (name === 'wait') return `Wait ${String(args.seconds || '')}s`
  if (name === 'web_search') return `Search: ${String(args.query || '')}`
  if (name === 'web_image_search') return `Image search: ${String(args.query || '')}`
  if (name === 'web_fetch') return `Fetch: ${String(args.url || '')}`
  if (typeof args.file_path === 'string') return `${name.replaceAll('_', ' ')} ${args.file_path}`
  return name.replaceAll('_', ' ')
}

function currentCatalog(input: StartAgentKernelRunInput): AgentToolCatalogOptions {
  return typeof input.catalog === 'function' ? input.catalog() : input.catalog
}

function replaceSystemPrompt(
  messages: ProviderChatMessage[],
  systemPrompt: string
): ProviderChatMessage[] {
  const index = messages.findIndex(({ role }) => role === 'system')
  if (index < 0) return [{ role: 'system', content: systemPrompt }, ...messages]
  return messages.map((message, messageIndex) =>
    messageIndex === index ? { ...message, content: systemPrompt } : message
  )
}

function toolRequestedAccess(
  catalog: AgentToolCatalogOptions,
  name: string,
  args: Record<string, unknown>
): RequestedAccess {
  const entry = getAgentToolEntry(catalog, name)
  if (!entry || entry.risk === 'read') return 'auto'
  if (name === 'apply_patch') return 'auto'
  if (name === 'shell' && commandCanRunWithoutApproval(String(args.command || ''))) return 'auto'
  return 'confirm'
}

function toolNeedsPolicyDecision(catalog: AgentToolCatalogOptions, name: string): boolean {
  const entry = getAgentToolEntry(catalog, name)
  if (!entry) return false
  if (name.startsWith('mcp__')) return entry.risk !== 'read'
  if (entry.risk !== 'write' && entry.risk !== 'execute') return false
  return ![
    'manage_todo_list',
    'update_goal',
    'complete_plan',
    'create_artifact',
    'collaboration_send',
    'collaboration_claim_complete'
  ].includes(name)
}

export async function sampleProviderTurn(
  request: ProviderChatRequest,
  signal: AbortSignal,
  onChunk: (chunk: ProviderStreamChunk) => void
): Promise<{ result: ProviderStreamResult; turn: AgentKernelModelTurn }> {
  let content = ''
  let thinking = ''
  const thinkingBlocks: ProviderThinkingBlock[] = []
  const toolCalls: ProviderToolCall[] = []
  let promptTokens = 0
  let cachedPromptTokens: number | undefined
  let completionTokens = 0
  let doneReason = 'stop'
  let firstGeneratedAt: number | undefined
  let streamEndedAt: number | undefined
  let evalDurationNs: number | undefined
  let reportedTokensPerSecond: number | undefined
  const requestStartedAt = Date.now()
  const result = await streamProviderChat(
    request,
    (chunk) => {
      if (
        firstGeneratedAt === undefined &&
        (chunk.message?.content ||
          chunk.message?.thinking ||
          (chunk.message?.tool_calls?.length ?? 0) > 0)
      ) {
        firstGeneratedAt = Date.now()
      }
      if (chunk.message?.content) content += chunk.message.content
      if (chunk.message?.thinking) thinking += chunk.message.thinking
      if (chunk.message?.thinking_blocks) thinkingBlocks.push(...chunk.message.thinking_blocks)
      if (chunk.message?.tool_calls) mergeToolCalls(toolCalls, chunk.message.tool_calls)
      if (chunk.prompt_eval_count !== undefined) promptTokens = chunk.prompt_eval_count
      if (chunk.cached_prompt_tokens !== undefined) {
        cachedPromptTokens = chunk.cached_prompt_tokens
      }
      if (chunk.eval_count !== undefined) completionTokens = chunk.eval_count
      if (chunk.eval_duration !== undefined) evalDurationNs = chunk.eval_duration
      if (chunk.predicted_per_second !== undefined) {
        reportedTokensPerSecond = chunk.predicted_per_second
      }
      if (chunk.done_reason) doneReason = chunk.done_reason
      if (chunk.done) streamEndedAt = Date.now()
      onChunk(chunk)
    },
    signal
  )
  const wallClockSeconds =
    firstGeneratedAt !== undefined ? ((streamEndedAt ?? Date.now()) - firstGeneratedAt) / 1_000 : 0
  const tokensPerSecond =
    reportedTokensPerSecond && reportedTokensPerSecond > 0
      ? reportedTokensPerSecond
      : evalDurationNs && evalDurationNs > 0 && completionTokens > 0
        ? completionTokens / (evalDurationNs / 1e9)
        : wallClockSeconds > 0.1 && completionTokens > 0
          ? completionTokens / wallClockSeconds
          : undefined
  return {
    result,
    turn: {
      content,
      thinking,
      thinkingBlocks,
      toolCalls: toolCalls.map((call) => ({ ...call, id: call.id || randomUUID() })),
      usage: {
        promptTokens,
        ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
        completionTokens,
        doneReason,
        tokensPerSecond,
        ...(firstGeneratedAt === undefined
          ? {}
          : { timeToFirstTokenMs: firstGeneratedAt - requestStartedAt })
      },
      ...(result.generationId ? { generationId: result.generationId } : {})
    }
  }
}

export class AgentRunKernel {
  private readonly active = new Map<string, ActiveKernelRun>()
  private readonly pendingResolvers = new Map<string, PendingResolver>()

  constructor(
    private readonly store: AgentRunStore,
    private readonly tools = new AgentToolRegistry(),
    private readonly sample: AgentKernelProviderSampler = sampleProviderTurn,
    private readonly publish: (event: AgentRunEvent) => void = () => undefined
  ) {}

  start(input: StartAgentKernelRunInput): Promise<AgentKernelRunResult> {
    if (this.active.has(input.id)) throw new Error(`Agent run is already active: ${input.id}`)
    const controller = new AbortController()
    const promise = this.execute(input, controller.signal).finally(() => {
      if (this.active.get(input.id)?.controller === controller) this.active.delete(input.id)
      for (const [id, pending] of this.pendingResolvers) {
        if (pending.runId === input.id) this.pendingResolvers.delete(id)
      }
    })
    this.active.set(input.id, { controller, promise })
    return promise
  }

  stop(runId: string): boolean {
    const active = this.active.get(runId)
    if (!active) return false
    active.controller.abort()
    return true
  }

  isActive(runId: string): boolean {
    return this.active.has(runId)
  }

  hasActiveRuns(): boolean {
    return this.active.size > 0
  }

  async stopAll(): Promise<void> {
    const activeRuns = [...this.active.values()]
    for (const { controller } of activeRuns) controller.abort()
    await Promise.allSettled(activeRuns.map(({ promise }) => promise))
  }

  async wait(runId: string): Promise<AgentKernelRunResult | null> {
    return (await this.active.get(runId)?.promise) ?? null
  }

  resolveInteraction(
    interactionId: string,
    response: Record<string, unknown>,
    cancelled = false
  ): PendingAgentInteraction {
    const interaction = this.store.resolveInteraction(interactionId, response, cancelled)
    const event = this.store.listEvents(interaction.runId, 0).at(-1)
    if (event) this.publish(event)
    this.pendingResolvers.get(interactionId)?.resolve(interaction)
    this.pendingResolvers.delete(interactionId)
    return interaction
  }

  private append(
    runId: string,
    type: AgentRunEvent['type'],
    payload: Record<string, unknown>
  ): AgentRunEvent {
    const event = this.store.appendEvent({ id: randomUUID(), runId, type, payload })
    this.publish(event)
    return event
  }

  private transition(
    runId: string,
    phase: AgentRunPhase,
    error?: ToolExecutionResult['error']
  ): void {
    const before = this.store.get(runId)?.lastSequence ?? 0
    this.store.transition(runId, phase, randomUUID(), error)
    const event = this.store.listEvents(runId, before, 1)[0]
    if (event) this.publish(event)
  }

  private async suspendForInteraction(
    runId: string,
    kind: PendingAgentInteraction['kind'],
    request: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<PendingAgentInteraction> {
    this.transition(runId, kind === 'permission' ? 'awaiting_permission' : 'awaiting_user')
    const id = randomUUID()
    const before = this.store.get(runId)?.lastSequence ?? 0
    this.store.createInteraction({ id, runId, kind, request })
    const event = this.store.listEvents(runId, before, 1)[0]
    if (event) this.publish(event)
    return new Promise<PendingAgentInteraction>((resolve) => {
      const abort = (): void => {
        if (this.store.getInteraction(id)?.status === 'pending') {
          const cancelled = this.store.resolveInteraction(id, { reason: 'run_cancelled' }, true)
          const resolvedEvent = this.store.listEvents(runId, event?.sequence ?? before, 1)[0]
          if (resolvedEvent) this.publish(resolvedEvent)
          resolve(cancelled)
        }
        this.pendingResolvers.delete(id)
      }
      if (signal.aborted) return abort()
      signal.addEventListener('abort', abort, { once: true })
      this.pendingResolvers.set(id, {
        runId,
        resolve: (resolved) => {
          signal.removeEventListener('abort', abort)
          resolve(resolved)
        }
      })
    })
  }

  private async executeAskUser(
    runId: string,
    title: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    startedAt: number
  ): Promise<ToolExecutionResult> {
    const interaction = await this.suspendForInteraction(runId, 'question', args, signal)
    if (interaction.status !== 'resolved') {
      return toolExecutionFailed({
        title,
        code: 'cancelled',
        message: 'The user question was cancelled',
        status: 'cancelled',
        startedAt
      })
    }
    return toolExecutionSucceeded({
      title,
      data: { answers: interaction.response ?? {} },
      startedAt
    })
  }

  private async executePlanEntry(
    input: StartAgentKernelRunInput,
    args: Record<string, unknown>,
    signal: AbortSignal,
    startedAt: number,
    title: string
  ): Promise<{ result: ToolExecutionResult; transition?: AgentKernelRuntimeTransition }> {
    if (!input.planController || input.planController.stage() !== 'inactive') {
      return {
        result: toolExecutionFailed({
          title,
          code: 'unsupported',
          message: 'Plan mode cannot be entered from the current run state',
          startedAt
        })
      }
    }
    const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 2_000) : ''
    const interaction = await this.suspendForInteraction(
      input.id,
      'plan_approval',
      {
        stage: 'entry',
        reason,
        plannerModel: input.promptContext?.plannerModel ?? input.model,
        executorModel: input.promptContext?.executorModel ?? input.model
      },
      signal
    )
    const approved =
      interaction.status === 'resolved' &&
      (interaction.response?.action === 'approve' || interaction.response?.approved === true)
    if (!approved) {
      return {
        result: toolExecutionSucceeded({
          title,
          data: { entered: false },
          modelContent:
            'The user chose to remain in Act mode. Continue the current request directly and ask only focused questions that are genuinely necessary.',
          startedAt
        })
      }
    }
    const transition = await input.planController.enter()
    return {
      transition,
      result: toolExecutionSucceeded({
        title,
        data: { entered: true, plannerModel: transition.model },
        modelContent: `<sidekick_plan_mode trust="app-policy">
The user approved Plan mode. The runtime has removed all project mutations, shell commands, MCP calls, artifacts, collaboration writes, and child agents. Explore with the currently available read-only tools, ask focused questions when needed, and finish by calling present_plan with a verifiable contract. Do not implement yet.
</sidekick_plan_mode>`,
        startedAt
      })
    }
  }

  private async executePlanReview(
    input: StartAgentKernelRunInput,
    args: Record<string, unknown>,
    signal: AbortSignal,
    startedAt: number,
    title: string
  ): Promise<{ result: ToolExecutionResult; transition?: AgentKernelRuntimeTransition }> {
    if (!input.planController || input.planController.stage() !== 'planning') {
      return {
        result: toolExecutionFailed({
          title,
          code: 'unsupported',
          message: 'No Plan-mode contract is awaiting review',
          startedAt
        })
      }
    }
    let review: AgentPlanReview
    try {
      review = await input.planController.prepareReview(args.plan)
    } catch (error) {
      return {
        result: toolExecutionFailed({
          title,
          code: 'invalid_arguments',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
          recoveryAction: 'correct_input',
          recovery:
            'Correct the structured plan so every step and verification check references known requirement IDs, then present it once.',
          startedAt
        })
      }
    }
    const interaction = await this.suspendForInteraction(
      input.id,
      'plan_approval',
      { stage: 'review', ...review },
      signal
    )
    if (interaction.status !== 'resolved') {
      return {
        result: toolExecutionFailed({
          title,
          code: 'cancelled',
          message: 'Plan review was cancelled',
          status: 'cancelled',
          startedAt
        })
      }
    }
    const responseRevision = String(interaction.response?.revision || '')
    if (responseRevision !== review.revision) {
      return {
        result: toolExecutionFailed({
          title,
          code: 'conflict',
          message: 'The reviewed plan revision is stale',
          retryable: true,
          recoveryAction: 'refresh_state',
          recovery: 'Present the current plan contract again.',
          startedAt
        })
      }
    }
    const action = String(interaction.response?.action || 'keep')
    if (action === 'revise') {
      const feedback = String(interaction.response?.feedback || '')
        .trim()
        .slice(0, 4_000)
      await input.planController.revise(review.revision)
      return {
        result: toolExecutionSucceeded({
          title,
          data: { planAction: 'revise', revision: review.revision },
          modelContent: `<sidekick_plan_revision trust="user-decision" revision="${review.revision}">
The user requested a revision. Keep Plan mode active, incorporate the feedback, and call present_plan again with a complete new contract.

Feedback: ${feedback || 'Revise the plan before presenting it again.'}
</sidekick_plan_revision>`,
          startedAt
        })
      }
    }
    if (action === 'approve') {
      const transition = await input.planController.approve(review.revision)
      return {
        transition,
        result: toolExecutionSucceeded({
          title,
          data: { planAction: 'approve', revision: review.revision },
          modelContent: `<approved_plan_contract trust="user-approved" revision="${review.revision}">
${JSON.stringify(review.contract)}
</approved_plan_contract>
The user approved this exact plan revision. Act capabilities are now available and the configured execution model is active. Implement every step, keep the todo list current, run proportionate checks, and call complete_plan with concrete evidence for every requirement before the final response.`,
          startedAt
        })
      }
    }
    await input.planController.keep(review.revision)
    return {
      result: toolExecutionSucceeded({
        title,
        data: { planAction: 'keep', revision: review.revision },
        modelContent: 'The user kept the plan for later without starting implementation.',
        startedAt
      })
    }
  }

  private applyRuntimeTransition(
    input: StartAgentKernelRunInput,
    transition: AgentKernelRuntimeTransition
  ): void {
    const from = input.profile.executionMode
    input.profile = transition.profile
    const before = this.store.get(input.id)?.lastSequence ?? 0
    this.store.updateRuntime(input.id, {
      profile: transition.profile,
      provider: transition.provider,
      model: transition.model,
      from,
      to: transition.profile.executionMode,
      revision: transition.revision
    })
    const event = this.store.listEvents(input.id, before, 1)[0]
    if (event) this.publish(event)
    this.append(input.id, 'context.changed', {
      version: 1,
      from,
      to: transition.profile.executionMode,
      provider: transition.provider,
      model: transition.model,
      revision: transition.revision ?? null,
      systemPrompt: transition.systemPrompt ?? null,
      tools: getAgentToolDefinitions(currentCatalog(input))
    })
  }

  private async authorizeTool(
    input: StartAgentKernelRunInput,
    call: AgentToolCall,
    title: string,
    signal: AbortSignal
  ): Promise<boolean> {
    const catalog = currentCatalog(input)
    if (!toolNeedsPolicyDecision(catalog, call.name)) return true
    const requestedAccess = toolRequestedAccess(catalog, call.name, call.arguments)
    const decision = resolvePermissionPolicy(input.permissionMode, requestedAccess)
    if (decision.effectiveAccess === 'auto') {
      this.append(input.id, 'permission.resolved', {
        toolCallId: call.id,
        name: call.name,
        title,
        requestedAccess,
        effectiveAccess: 'auto',
        mode: input.permissionMode,
        approved: true,
        source: 'policy',
        arguments: input.toolRouter.safeArguments?.(call.name, call.arguments) ?? call.arguments
      })
      return true
    }
    const interaction = await this.suspendForInteraction(
      input.id,
      'permission',
      {
        toolCallId: call.id,
        name: call.name,
        title,
        requestedAccess,
        mode: input.permissionMode,
        arguments: input.toolRouter.safeArguments?.(call.name, call.arguments) ?? call.arguments
      },
      signal
    )
    return interaction.status === 'resolved' && interaction.response?.approved === true
  }

  private async compactContext(
    input: StartAgentKernelRunInput,
    contextManager: AgentKernelContextManager | undefined,
    messages: ProviderChatMessage[],
    tools: readonly unknown[],
    signal: AbortSignal,
    reason: 'preflight_budget' | 'provider_context_window_exceeded'
  ): Promise<{ messages: ProviderChatMessage[]; compacted: boolean }> {
    if (!contextManager) return { messages, compacted: false }
    this.transition(input.id, 'compacting')
    this.append(input.id, 'compaction.started', {
      messageCount: messages.length,
      reason
    })
    const prepared = await contextManager.compact(messages, tools, signal)
    const validated = validateProviderTranscript(prepared.messages).messages
    this.append(input.id, 'compaction.completed', {
      previousMessageCount: messages.length,
      messageCount: validated.length,
      compacted: prepared.compacted,
      reason,
      ...prepared.details
    })
    this.transition(input.id, 'streaming')
    return { messages: validated, compacted: prepared.compacted }
  }

  private async execute(
    input: StartAgentKernelRunInput,
    signal: AbortSignal
  ): Promise<AgentKernelRunResult> {
    const started = this.store.start(input)
    const startedEvent = this.store.listEvents(input.id, 0, 1)[0]
    if (startedEvent) this.publish(startedEvent)
    let messages = validateProviderTranscript(input.messages).messages
    this.append(input.id, 'context.snapshot', {
      version: 1,
      messages,
      tools: getAgentToolDefinitions(currentCatalog(input)),
      promptContext: input.promptContext ?? {},
      provider: input.provider,
      model: input.model
    })
    let finalContent = ''
    let finalThinking = ''
    let toolRounds = 0
    const toolRecovery = new AgentToolRecoveryController()
    let researchSourceAttempted = false
    let researchGuardInjected = false
    let goalContinuationTurn = false
    let contextOverflowRetryAttempted = false
    let activeRequest = input.request
    let activeContextManager = input.contextManager

    try {
      this.transition(started.id, 'streaming')
      while (!signal.aborted) {
        if (input.beforeModelStep) {
          const injected = await input.beforeModelStep(messages, signal, toolRounds)
          if (injected.length) messages = [...messages, ...injected]
        }
        const validated = validateProviderTranscript(messages)
        let requestMessages = validated.messages
        messages = requestMessages
        if (validated.repairs.length) {
          this.append(input.id, 'run.retrying', {
            reason: 'provider_transcript_repaired',
            repairs: validated.repairs
          })
        }

        const toolDefinitions = getAgentToolDefinitions(currentCatalog(input))
        if (activeContextManager?.shouldCompact(requestMessages, toolDefinitions)) {
          const prepared = await this.compactContext(
            input,
            activeContextManager,
            requestMessages,
            toolDefinitions,
            signal,
            'preflight_budget'
          )
          requestMessages = prepared.messages
          messages = requestMessages
        }

        let pendingContent = goalContinuationTurn ? '\n\n' : ''
        let pendingThinking = ''
        let lastDeltaAt = Date.now()
        const previewSignatures = new Map<string, string>()
        const flushDelta = (): void => {
          if (!pendingContent && !pendingThinking) return
          this.append(input.id, 'assistant.delta', {
            content: pendingContent,
            thinking: pendingThinking
          })
          pendingContent = ''
          pendingThinking = ''
          lastDeltaAt = Date.now()
        }
        let acceptingChunks = true
        let sampled: Awaited<ReturnType<AgentKernelProviderSampler>>
        try {
          sampled = await abortablePromise(
            this.sample(
              {
                ...activeRequest,
                messages: requestMessages,
                tools: toolDefinitions
              },
              signal,
              (chunk) => {
                if (!acceptingChunks || signal.aborted) return
                pendingContent += chunk.message?.content || ''
                pendingThinking += chunk.message?.thinking || ''
                if (
                  pendingContent.length + pendingThinking.length >= 1_024 ||
                  Date.now() - lastDeltaAt >= 50 ||
                  chunk.done
                ) {
                  flushDelta()
                }
                for (const call of chunk.message?.tool_calls ?? []) {
                  const id = call.id || `tool_index_${call.index ?? 0}`
                  const preview = safePreview(call)
                  const signature = JSON.stringify([call.function.name, preview])
                  if (previewSignatures.get(id) === signature) continue
                  previewSignatures.set(id, signature)
                  this.append(input.id, 'tool.pending', {
                    toolCallId: id,
                    name: call.function.name,
                    arguments: preview,
                    presentation: presentAgentToolCall(
                      currentCatalog(input),
                      call.function.name,
                      preview
                    )
                  })
                }
              }
            ),
            signal,
            'Agent run cancelled'
          )
        } finally {
          acceptingChunks = false
          flushDelta()
        }
        if (!sampled.result.ok) {
          const providerError = sampled.result.error || 'Provider stream failed'
          const overflow = providerContextWindowError(providerError)
          if (overflow && activeContextManager && !contextOverflowRetryAttempted) {
            contextOverflowRetryAttempted = true
            this.append(input.id, 'run.retrying', {
              reason: 'context_window_exceeded',
              ...overflow
            })
            const prepared = await this.compactContext(
              input,
              activeContextManager,
              requestMessages,
              toolDefinitions,
              signal,
              'provider_context_window_exceeded'
            )
            if (prepared.compacted) {
              messages = prepared.messages
              continue
            }
          }
          throw new Error(providerError)
        }
        contextOverflowRetryAttempted = false
        const turn = {
          ...sampled.turn,
          toolCalls: uniqueToolCallIds(sampled.turn.toolCalls)
        }
        const truncatedToolBatch =
          turn.toolCalls.length > 0 && toolBatchMayBeTruncated(turn.usage.doneReason)
        activeContextManager?.observeUsage?.(
          requestMessages,
          toolDefinitions,
          turn.usage.promptTokens
        )
        const assistantMessage: ProviderChatMessage = {
          role: 'assistant',
          content: turn.content || null,
          ...(turn.thinkingBlocks.length ? { thinking_blocks: turn.thinkingBlocks } : {}),
          ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls } : {})
        }
        messages = [...requestMessages, assistantMessage]
        const projectedTurnContent =
          goalContinuationTurn && turn.content ? `\n\n${turn.content}` : turn.content
        goalContinuationTurn = false
        const needsResearchSource =
          input.profile.surface === 'research' &&
          !researchSourceAttempted &&
          turn.toolCalls.length === 0
        const planStage = input.planController?.stage()
        const planningDecision =
          !needsResearchSource && !turn.toolCalls.length && planStage === 'planning'
            ? await input.planController?.afterTerminalTurn()
            : undefined
        const verificationDecision =
          !needsResearchSource &&
          !turn.toolCalls.length &&
          planStage !== 'planning' &&
          input.verificationController
            ? await input.verificationController.afterTerminalTurn()
            : undefined
        const executionPlanDecision =
          !needsResearchSource &&
          !turn.toolCalls.length &&
          planStage === 'executing' &&
          verificationDecision?.continue !== true
            ? await input.planController?.afterTerminalTurn()
            : undefined
        const planDecision = planningDecision ?? executionPlanDecision
        if (verificationDecision) {
          this.append(input.id, 'verification.updated', {
            summary: verificationDecision.summary
          })
        }
        this.append(input.id, 'assistant.completed', {
          content: projectedTurnContent,
          thinking: turn.thinking,
          thinkingBlocks: turn.thinkingBlocks,
          toolCalls: turn.toolCalls.map((call) => ({
            id: call.id,
            index: call.index,
            name: call.function.name,
            arguments:
              (truncatedToolBatch
                ? undefined
                : input.toolRouter.safeArguments?.(call.function.name, objectArguments(call))) ??
              safePreview(call)
          })),
          usage: turn.usage,
          generationId: turn.generationId,
          provisional:
            needsResearchSource ||
            verificationDecision?.continue === true ||
            planDecision?.continue === true ||
            Boolean(planDecision?.error)
        })
        this.append(input.id, 'usage.updated', turn.usage)
        input.goalController?.onUsage?.(turn.usage)

        if (needsResearchSource) {
          if (!researchGuardInjected) {
            researchGuardInjected = true
            this.append(input.id, 'run.retrying', { reason: 'research_source_required' })
            messages = [...messages, { role: 'user', content: RESEARCH_SOURCE_GUARD }]
            continue
          }
          this.append(input.id, 'assistant.completed', {
            content: RESEARCH_UNVERIFIED_RESPONSE,
            thinking: '',
            thinkingBlocks: [],
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, doneReason: 'research_guard' },
            synthetic: true
          })
          this.transition(input.id, 'completed')
          return {
            runId: input.id,
            phase: 'completed',
            content: RESEARCH_UNVERIFIED_RESPONSE,
            finalResponse: RESEARCH_UNVERIFIED_RESPONSE,
            thinking: finalThinking,
            messages,
            toolRounds
          }
        }

        if (
          verificationDecision?.continue !== true &&
          planDecision?.continue !== true &&
          !planDecision?.error
        ) {
          finalContent += projectedTurnContent
          finalThinking += turn.thinking
        }

        if (!turn.toolCalls.length) {
          if (planDecision?.error) throw new AgentToolLoopError(planDecision.error)
          if (planDecision?.continue) {
            this.append(input.id, 'run.retrying', {
              reason:
                planStage === 'planning' ? 'plan_contract_required' : 'plan_completion_required'
            })
            messages = [
              ...messages,
              {
                role: 'user',
                content:
                  planDecision.prompt ||
                  'Continue until the current Plan-mode contract requirement is satisfied.'
              }
            ]
            continue
          }
          if (verificationDecision?.continue) {
            this.append(input.id, 'run.retrying', { reason: 'workspace_verification_required' })
            messages = [
              ...messages,
              {
                role: 'user',
                content:
                  verificationDecision.prompt ||
                  'Verify the workspace changes with the smallest relevant project check, then report the actual result.'
              }
            ]
            continue
          }
          if (input.goalController) {
            const decision = await input.goalController.afterTerminalTurn({
              finalResponse: turn.content,
              messages,
              toolRounds
            })
            if (decision.continue) {
              this.append(input.id, 'run.retrying', { reason: 'goal_continuation' })
              messages = [
                ...messages,
                {
                  role: 'user',
                  content:
                    decision.prompt ||
                    'Continue making concrete progress toward the active goal. Do not stop merely because one response ended.'
                }
              ]
              goalContinuationTurn = true
              continue
            }
          }
          this.transition(input.id, 'completed')
          return {
            runId: input.id,
            phase: 'completed',
            content: finalContent,
            finalResponse: turn.content,
            thinking: finalThinking,
            messages,
            toolRounds
          }
        }

        toolRounds++
        if (toolRounds > Math.max(1, input.maxToolRounds)) {
          const decision = await this.suspendForInteraction(
            input.id,
            'tool_limit',
            {
              roundsUsed: toolRounds - 1,
              requestedAdditionalRounds: Math.max(25, Math.ceil(input.maxToolRounds / 2))
            },
            signal
          )
          if (decision.status !== 'resolved' || decision.response?.approved !== true) {
            throw new Error('Tool round limit reached and continuation was not approved')
          }
          input.maxToolRounds += Math.max(25, Math.ceil(input.maxToolRounds / 2))
        }

        let turnSuccessCount = 0
        let turnFailureCount = 0
        let lastToolMessage: ProviderChatMessage | undefined
        let callStopReason: string | undefined
        let planKeepRequested = false
        const preparedBatch = turn.toolCalls.map((providerCall) => {
          const parsed = truncatedToolBatch
            ? { arguments: safePreview(providerCall) }
            : parsedToolArguments(providerCall)
          const prepared = prepareAgentToolCall(currentCatalog(input), {
            id: providerCall.id || randomUUID(),
            name: providerCall.function.name,
            arguments: parsed.arguments
          })
          const call = prepared.call
          const title =
            input.toolRouter.title?.(call.name, call.arguments) ??
            defaultToolTitle(call.name, call.arguments)
          const safeArguments =
            input.toolRouter.safeArguments?.(call.name, call.arguments) ?? safePreview(providerCall)
          const presentation = presentAgentToolCall(currentCatalog(input), call.name, safeArguments)
          return { providerCall, prepared, call, title, safeArguments, presentation }
        })
        for (const item of preparedBatch) {
          if (RESEARCH_SOURCE_TOOLS.has(item.call.name)) researchSourceAttempted = true
          if (!previewSignatures.has(item.call.id)) {
            this.append(input.id, 'tool.pending', {
              toolCallId: item.call.id,
              name: item.call.name,
              arguments: item.safeArguments,
              presentation: item.presentation
            })
          }
        }
        if (truncatedToolBatch) {
          this.append(input.id, 'run.retrying', {
            reason: 'truncated_tool_batch',
            doneReason: turn.usage.doneReason,
            toolCallCount: turn.toolCalls.length
          })
        }
        const preExecuted = new Map<string, ToolExecutionResult>()
        for (let callIndex = 0; callIndex < preparedBatch.length; callIndex++) {
          if (signal.aborted) break
          const item = preparedBatch[callIndex]
          const { prepared, call, title, safeArguments, presentation: callPresentation } = item
          const entry = getAgentToolEntry(currentCatalog(input), call.name)
          if (
            !truncatedToolBatch &&
            entry?.concurrency === 'parallel' &&
            !preExecuted.has(call.id)
          ) {
            const group = [item]
            while (callIndex + group.length < preparedBatch.length) {
              const sibling = preparedBatch[callIndex + group.length]
              const siblingEntry = getAgentToolEntry(currentCatalog(input), sibling.call.name)
              if (siblingEntry?.concurrency !== 'parallel') break
              group.push(sibling)
            }
            await Promise.all(
              group.map(async (parallelItem) => {
                const parallelStartedAt = Date.now()
                const invalid = validatePreparedAgentToolCall(
                  currentCatalog(input),
                  parallelItem.call,
                  parallelItem.title,
                  parallelStartedAt,
                  parallelItem.prepared.repairs
                )
                if (invalid) {
                  preExecuted.set(parallelItem.call.id, invalid)
                  return
                }
                this.transition(input.id, 'executing_tool')
                this.append(input.id, 'tool.running', {
                  toolCallId: parallelItem.call.id,
                  name: parallelItem.call.name,
                  title: parallelItem.presentation.title || parallelItem.title,
                  arguments: parallelItem.safeArguments,
                  presentation: parallelItem.presentation
                })
                const result = await this.tools.execute(
                  {
                    catalog: currentCatalog(input),
                    call: parallelItem.call,
                    title: parallelItem.title,
                    context: {
                      runId: input.id,
                      conversationId: input.threadId,
                      workspaceRoot: input.workspaceRoot,
                      signal,
                      onOutput: ({ chunk, stream }) =>
                        this.append(input.id, 'tool.output.delta', {
                          toolCallId: parallelItem.call.id,
                          stream,
                          chunk
                        })
                    }
                  },
                  ((args, context) =>
                    input.toolRouter.execute(
                      parallelItem.call.name,
                      args,
                      context
                    )) as AgentToolExecutor
                )
                preExecuted.set(parallelItem.call.id, result)
              })
            )
          }
          const startedAt = Date.now()
          let result: ToolExecutionResult
          const parallelResult = preExecuted.get(call.id)
          if (parallelResult) {
            result = parallelResult
          } else if (truncatedToolBatch) {
            result = toolExecutionFailed({
              title,
              code: 'output_truncated',
              message: `Tool was not executed because the provider stopped this response with ${turn.usage.doneReason} while emitting tool calls. Its arguments may be incomplete.`,
              retryable: true,
              recoveryAction: 'change_strategy',
              recovery:
                'Re-issue a smaller, focused tool call in a new response. Do not assume any call from this batch ran.',
              startedAt
            })
          } else if (callStopReason) {
            result = toolExecutionFailed({
              title,
              code: 'loop_detected',
              message: `Tool was not executed because an earlier call in this batch triggered the run loop guard: ${callStopReason}`,
              retryable: false,
              recoveryAction: 'stop',
              startedAt
            })
          } else {
            const invalid = validatePreparedAgentToolCall(
              currentCatalog(input),
              call,
              title,
              startedAt,
              prepared.repairs
            )
            if (invalid) result = invalid
            else if (call.name === 'ask_user') {
              result = await this.executeAskUser(input.id, title, call.arguments, signal, startedAt)
            } else if (call.name === 'enter_plan_mode') {
              const outcome = await this.executePlanEntry(
                input,
                call.arguments,
                signal,
                startedAt,
                title
              )
              result = outcome.result
              if (outcome.transition) {
                this.applyRuntimeTransition(input, outcome.transition)
                activeRequest = outcome.transition.request
                activeContextManager = outcome.transition.contextManager
                if (outcome.transition.systemPrompt) {
                  messages = replaceSystemPrompt(messages, outcome.transition.systemPrompt)
                }
              }
            } else if (call.name === 'present_plan') {
              const outcome = await this.executePlanReview(
                input,
                call.arguments,
                signal,
                startedAt,
                title
              )
              result = outcome.result
              if (outcome.transition) {
                this.applyRuntimeTransition(input, outcome.transition)
                activeRequest = outcome.transition.request
                activeContextManager = outcome.transition.contextManager
                if (outcome.transition.systemPrompt) {
                  messages = replaceSystemPrompt(messages, outcome.transition.systemPrompt)
                }
              }
            } else if (!(await this.authorizeTool(input, call, title, signal))) {
              result = toolExecutionFailed({
                title,
                code: 'permission_denied',
                message: 'Operation denied by the user',
                status: 'denied',
                startedAt
              })
            } else {
              this.transition(input.id, 'executing_tool')
              this.append(input.id, 'tool.running', {
                toolCallId: call.id,
                name: call.name,
                title: callPresentation.title || title,
                arguments: safeArguments,
                presentation: callPresentation
              })
              result = await this.tools.execute(
                {
                  catalog: currentCatalog(input),
                  call,
                  title,
                  context: {
                    runId: input.id,
                    conversationId: input.threadId,
                    workspaceRoot: input.workspaceRoot,
                    signal,
                    onOutput: ({ chunk, stream }) =>
                      this.append(input.id, 'tool.output.delta', {
                        toolCallId: call.id,
                        stream,
                        chunk
                      })
                  }
                },
                ((args, context) =>
                  input.toolRouter.execute(call.name, args, context)) as AgentToolExecutor
              )
            }
          }
          const guard = callStopReason
            ? {}
            : toolRecovery.observeCall({
                name: call.name,
                arguments: call.arguments,
                result,
                readOnly: entry?.risk === 'read' && call.name !== 'wait' && call.name !== 'ask_user'
              })
          if (guard.warning) {
            result = withToolGuard(result, guard.warning)
            this.append(input.id, 'run.retrying', {
              reason: `tool_guard_${guard.reason}`,
              tool: call.name,
              count: guard.count
            })
          }
          if (guard.stopReason) {
            callStopReason = guard.stopReason
            result = toolExecutionFailed({
              title,
              code: 'loop_detected',
              message: guard.stopReason,
              retryable: false,
              recoveryAction: 'stop',
              recovery:
                'Stop this repeated approach. Start a materially different task or provide new information before trying again.',
              modelContent: `${result.modelContent}\n<sidekick_tool_guard trust="app-policy" reason="${guard.reason}" count="${guard.count}">\n${guard.stopReason}\n</sidekick_tool_guard>`,
              media: result.media,
              startedAt
            })
          }
          if (result.status === 'success') turnSuccessCount++
          else if (result.status === 'error') turnFailureCount++
          if (
            call.name === 'present_plan' &&
            result.data &&
            typeof result.data === 'object' &&
            (result.data as Record<string, unknown>).planAction === 'keep'
          ) {
            planKeepRequested = true
          }
          this.append(input.id, 'tool.completed', {
            toolCallId: call.id,
            name: call.name,
            result,
            presentation: presentAgentToolResult(
              currentCatalog(input),
              call.name,
              safeArguments,
              result
            )
          })
          lastToolMessage = {
            role: 'tool',
            tool_call_id: call.id,
            content: result.modelContent,
            ...(result.media?.length ? { media: result.media } : {})
          }
          messages.push(lastToolMessage)
        }
        if (callStopReason) throw new AgentToolLoopError(callStopReason)
        if (planKeepRequested) {
          const keptMessage = 'Plan saved for later. No project changes were made.'
          this.append(input.id, 'assistant.completed', {
            content: keptMessage,
            thinking: '',
            thinkingBlocks: [],
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, doneReason: 'plan_kept' },
            synthetic: true
          })
          finalContent += keptMessage
          this.transition(input.id, 'completed')
          return {
            runId: input.id,
            phase: 'completed',
            content: finalContent,
            finalResponse: keptMessage,
            thinking: finalThinking,
            messages,
            toolRounds
          }
        }
        const turnGuard = toolRecovery.observeTurn(turnSuccessCount, turnFailureCount)
        if (turnGuard.warning && lastToolMessage) {
          lastToolMessage.content = `${lastToolMessage.content || ''}\n${turnGuard.warning}`
          this.append(input.id, 'run.retrying', {
            reason: `tool_guard_${turnGuard.reason}`,
            count: turnGuard.count
          })
        }
        if (turnGuard.stopReason) throw new AgentToolLoopError(turnGuard.stopReason)
        if (!signal.aborted) this.transition(input.id, 'streaming')
      }
      throw new DOMException('Agent run cancelled', 'AbortError')
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError')
      const loopDetected = error instanceof AgentToolLoopError
      const message = cancelled
        ? 'Agent run cancelled'
        : error instanceof Error
          ? error.message
          : String(error)
      const failure = toolExecutionFailed({
        title: 'Agent run',
        code: cancelled ? 'cancelled' : loopDetected ? 'loop_detected' : 'internal',
        message,
        retryable: !cancelled && !loopDetected,
        recoveryAction: cancelled || loopDetected ? 'stop' : 'retry_later',
        recovery: loopDetected
          ? 'The run stopped because its tool calls were no longer making progress. Change the approach or provide new information before starting again.'
          : undefined,
        status: cancelled ? 'cancelled' : 'error'
      })
      this.transition(input.id, cancelled ? 'cancelled' : 'failed', failure.error)
      return {
        runId: input.id,
        phase: cancelled ? 'cancelled' : 'failed',
        content: finalContent,
        finalResponse: '',
        thinking: finalThinking,
        messages,
        toolRounds,
        error: message
      }
    }
  }
}
