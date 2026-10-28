import { randomUUID } from 'crypto'
import type { AgentArtifactDraft } from '../../shared/agentRunApi'
import {
  AgentToolLoopError,
  classifyAgentKernelFailure,
  ProviderRequestError,
  withToolGuard
} from './agentKernelFailure'
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
  type AgentApprovalPreview,
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
import {
  providerContextWindowError,
  providerImageLimitError,
  providerOutputLimitError,
  providerQuotaExhausted,
  providerStreamDropped
} from '../../shared/providerErrors'
import { resolveMaxOutputTokens } from '../../shared/contextBudget'
import { SCHEDULE_CHANGE_TOOLS } from '../../shared/scheduleTools'
import {
  countTranscriptImages,
  enforceImageBudget,
  FALLBACK_IMAGE_BUDGET
} from '../../shared/providerImageBudget'

/**
 * Image-count limits learned from a provider's rejection, keyed by
 * provider:model. The limit is a property of the model, so remembering it for
 * the rest of the session means only the first run that trips it pays a failed
 * request; every later run prunes before sending.
 */
const learnedImageLimits = new Map<string, number>()

/**
 * Context windows a provider reported about itself, keyed by provider:model.
 * A configured length that is too large is worse than none: compaction frees
 * against the wrong budget and the retry trips the same limit.
 */
const learnedContextLengths = new Map<string, number>()

/**
 * Reply limits a provider stated when it refused a larger one, keyed by provider:model. Hosted
 * APIs such as Groq cap a reply below what SideKick's default asks for, and many do not report
 * the cap in their model list.
 */
const learnedOutputLimits = new Map<string, number>()

function learnedLimitKey(provider: string, model: string): string {
  return `${provider}:${model}`
}
import { normalizeCompletedToolInput } from '../../shared/toolCalls'
import {
  agentPermissionDecision,
  resolvePermissionPolicy,
  type PermissionMode,
  type RequestedAccess
} from '../../shared/permissions'
import { agentPermissionScope } from './agentPermissionScope'
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
import { agentWaitTitle } from '../../shared/agentWait'
import {
  cutOffLimit,
  isOutputLimitStop,
  ToolCallRunawayGuard,
  type ToolBatchCutOff,
  type ToolCallRunaway
} from './toolBatchCutOff'

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
    providerDurationMs?: number
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
  /** What an approval would change, shown on the approval card. */
  approvalPreview?: (
    name: string,
    args: Record<string, unknown>,
    context?: AgentCredentialContext
  ) => Promise<AgentApprovalPreview | undefined>
  /**
   * How much a call asks for when that depends on state the arguments do not carry, such as a
   * web page's tool the page marks read-only. `always` asks every time, even in Full access, with
   * no chat-wide grant. Undefined leaves it to the tool's catalog entry.
   */
  requestedAccess?: (
    name: string,
    args: Record<string, unknown>,
    context: AgentCredentialContext
  ) => RequestedAccess | 'always' | undefined
  /** Holds the conversation's browser while the user clears a human check on its page. */
  reserveBrowserForHumanCheck?: (conversationId: string) => Promise<string>
  waitForBrowserHumanCheck?: (
    conversationId: string,
    expectedSessionId: string,
    signal: AbortSignal
  ) => Promise<void>
  releaseBrowserHumanCheck?: (conversationId: string, expectedSessionId: string) => Promise<void>
  /**
   * The approval a call that names a stored credential needs, or why the call is refused when the
   * use breaks a credential rule. Undefined when it names none.
   */
  credentialApproval?: (
    name: string,
    args: Record<string, unknown>,
    context: AgentCredentialContext
  ) => AgentCredentialApproval | { refused: string } | undefined
  /** The call was approved; only an approved call is given the credentials it names. */
  credentialApproved?: (
    name: string,
    args: Record<string, unknown>,
    context: AgentCredentialContext
  ) => void
  /** Records that the user refused a credential use. */
  credentialDenied?: (
    name: string,
    args: Record<string, unknown>,
    context: AgentCredentialContext
  ) => void
  /** The run ended: what it was given for its own use, such as returned tokens, lapses. */
  releaseRun?: (runId: string) => void
}

export interface AgentCredentialContext {
  conversationId: string
  runId: string
  toolCallId: string
}

/** What a call that uses a credential shows before it runs. */
export interface AgentCredentialApproval {
  alias: string
  /** The chat grant that covers the same entries again. */
  keys: string[]
  label: string
  preview: AgentApprovalPreview
}

export interface AgentKernelContextManager {
  shouldCompact(messages: ProviderChatMessage[], tools: readonly unknown[]): boolean
  /** The reply limit for this request: the model's own, cut to the room the window has left. */
  replyLimit?(
    messages: ProviderChatMessage[],
    tools: readonly unknown[],
    maxOutputTokens: number | undefined
  ): number | undefined
  /** Adopt a window the provider reported about itself. */
  applyContextLength?(contextLength: number, maxOutputTokens: number): void
  /** Learns from the provider's real prompt count; returns the estimate it compared against. */
  observeUsage?(
    messages: ProviderChatMessage[],
    tools: readonly unknown[],
    promptTokens: number
  ): number | undefined | void
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

/** Files named in one message that are read up front; more are left for the model to open. */
const MAX_PRELOADED_READS = 4
// How long a run waits for the user to clear a human check in the Browser panel.
const HUMAN_CHECK_WAIT_MS = 10 * 60_000

/**
 * How long a turn whose stream broke off waits before it is asked again, once. A local model
 * proxy that restarts or swaps models dropped four replies in an hour, and each failed its run.
 */
export const STREAM_DROP_RETRY_DELAY_MS = 3_000

/**
 * How long a run waits before asking again when the provider is limiting requests or busy (429,
 * 503, 529), one wait per attempt. One 429 from a free tier or a LiteLLM limit ended a run in its
 * first second. A gateway with nothing behind it (502, 504) fails at once: the user has a server
 * to start, and waiting would only hide that.
 */
export const PROVIDER_BUSY_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000]
const PROVIDER_BUSY_STATUSES = new Set([429, 503, 529])
/**
 * The longest wait a provider's Retry-After is followed for. A provider that asks for longer, such
 * as a daily limit, will not be ready while the user watches, and the run fails at once.
 */
const PROVIDER_RETRY_AFTER_LIMIT_MS = 60_000

export interface StartAgentKernelRunInput extends StartAgentRunInput {
  /** App-settings snapshot, never model/repository-discovered commands. Always requires approval. */
  projectStartCommands?: string[]
  projectCompletionCommands?: string[]
  /** Project files the user named in the message, read before the model's first turn. */
  preloadReads?: string[]
  catalog: AgentToolCatalogOptions | (() => AgentToolCatalogOptions)
  messages: ProviderChatMessage[]
  request: Omit<ProviderChatRequest, 'messages' | 'tools'>
  maxToolRounds: number
  permissionMode: PermissionMode
  toolRouter: AgentKernelToolRouter
  contextManager?: AgentKernelContextManager
  /** Messages the run takes in before its first model request, recorded like a steer. */
  initialSteers?: AgentRunSteer[]
  /** Injects newly arrived external events at safe provider boundaries. */
  beforeModelStep?: (
    messages: ProviderChatMessage[],
    signal: AbortSignal,
    toolRounds: number
  ) => Promise<ProviderChatMessage[]>
  /** Keeps a durable objective alive after an otherwise terminal model turn. */
  goalController?: {
    onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void
    /**
     * True once the durable goal has been completed. The run may still take the
     * turn it needs to answer the completing tool call, but no further tool work.
     */
    isComplete?: () => boolean
    afterTerminalTurn: (input: {
      finalResponse: string
      messages: ProviderChatMessage[]
      toolRounds: number
    }) => Promise<{ continue: boolean; prompt?: string }>
  }
  /** Requires one bounded, evidence-based verification pass before workspace-changing runs finish. */
  verificationController?: {
    afterTerminalTurn: () => Promise<VerificationTerminalDecision>
    beforeGoalCompletion?: () => VerificationTerminalDecision
    afterToolRound?: () => string | undefined
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

/** A user message sent while a run works, taken in at its next model step. */
export interface AgentRunSteer {
  id: string
  message: ProviderChatMessage
  /** What the user sent, recorded on `run.steered` for display and later history. */
  payload: Record<string, unknown>
  /** Runs once the message is durably part of the run. */
  onApplied?: () => void
}

// A run waiting on the user has no model step coming; the message would sit
// unseen behind the question, so it waits for the run to end instead.
const STEERABLE_PHASES = new Set<AgentRunPhase>([
  'queued',
  'streaming',
  'executing_tool',
  'compacting'
])

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

function safePreview(call: ProviderToolCall): Record<string, unknown> {
  const raw = call.function.arguments
  if (typeof raw === 'string') return previewToolCallArguments(raw)
  const preview: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (TOOL_PREVIEW_FIELDS.has(key)) preview[key] = value
  }
  return preview
}

const tokenCount = (value: number): string => `${value.toLocaleString('en-US')} tokens`

/**
 * The refusal of every call in a reply the output limit cut off. Arguments from such a reply are
 * unsafe even when their JSON happens to parse: the model may have stopped at a syntactically
 * valid but incomplete point, and a reply that ran away writes the same call hundreds of times.
 */
function cutOffToolResult(
  title: string,
  cutOff: ToolBatchCutOff,
  startedAt: number,
  toolName: string
): ToolExecutionResult {
  const room =
    cutOffLimit(cutOff) === 'shrunk'
      ? ` The limit was below the model's ${tokenCount(cutOff.maxOutputTokens!)} because the conversation is near the end of the model's context window.`
      : ''
  return toolExecutionFailed({
    title,
    code: 'output_truncated',
    message:
      `Tool was not executed: your reply reached its output limit` +
      `${cutOff.replyLimit ? ` of ${tokenCount(cutOff.replyLimit)}` : ''} (${cutOff.doneReason}) ` +
      `while writing tool calls, so none of its ${cutOff.toolCallCount} ${cutOff.toolCallCount === 1 ? 'call' : 'calls'} ran; ` +
      `their arguments may be incomplete.${room}`,
    retryable: true,
    recoveryAction: 'change_strategy',
    // An artifact cannot be written in parts; the same artifact written more tightly fits.
    recovery:
      toolName === 'create_artifact'
        ? 'Write the artifact again, more compactly: build repeated elements from arrays with map, compute data instead of listing it value by value, and keep it to a few hundred lines. Plan it briefly: thinking counts toward the same limit.'
        : 'Re-issue fewer, smaller calls in a new response. Split a long file into several edits or appends, and save a long script to a file in parts before running it. Do not assume any call from this batch ran.',
    startedAt
  })
}

/**
 * What the model is told after SideKick stopped a reply that ran away. Gemini CLI does the same:
 * the first loop stops the stream and tells the model, a second ends the turn.
 */
function runawayNotice(runaway: ToolCallRunaway): string {
  const what =
    runaway.kind === 'repeated_call'
      ? `it wrote the same ${runaway.toolName} call, with the same arguments, ${runaway.identicalCalls} times`
      : `it had written ${runaway.toolCallCount} tool calls, more than one reply may make`
  return `<sidekick_runaway_reply trust="app-policy">SideKick stopped your last reply because ${what}. None of its tool calls ran. Make one call, read its result, and decide the next step from what it shows. Repeat a call only when something has changed.</sidekick_runaway_reply>`
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
    // A stream's index names the call; two calls a server gave one id are still two calls.
    const index = existing.findIndex((candidate) =>
      call.index !== undefined && candidate.index !== undefined
        ? candidate.index === call.index
        : Boolean(call.id) && candidate.id === call.id
    )
    if (index >= 0) existing[index] = call
    else existing.push(call)
  }
}

function defaultToolTitle(name: string, args: Record<string, unknown>): string {
  if (name === 'shell') return String(args.title || 'Run command')
  if (name === 'wait') return agentWaitTitle(args)
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
  // Reading an API changes nothing; sending to one may.
  if (name === 'http_request' && ['GET', 'HEAD'].includes(String(args.method).toUpperCase())) {
    return 'auto'
  }
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
    // Changes an artifact in place, as create_artifact makes one; a builder's card is not shown.
    'edit_artifact',
    // The sessions handler shows its own start card when the permission mode asks for one.
    'start_session',
    'send_message',
    'stop_session',
    // A valid schedule change asks every time through the router; an invalid one is refused by
    // its handler, which saves nothing, without a card.
    ...SCHEDULE_CHANGE_TOOLS
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
        providerDurationMs: Math.max(0, Date.now() - requestStartedAt),
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
  private readonly steers = new Map<string, AgentRunSteer[]>()
  // Scopes the user allowed "for this chat", by conversation. Kept in memory on
  // purpose: they last for this app session and never become standing rules.
  private readonly chatGrants = new Map<string, Set<string>>()

  constructor(
    private readonly store: AgentRunStore,
    private readonly tools = new AgentToolRegistry(),
    private readonly sample: AgentKernelProviderSampler = sampleProviderTurn,
    private readonly publish: (event: AgentRunEvent) => void = () => undefined,
    private readonly publishArtifactDraft: (draft: AgentArtifactDraft) => void = () => undefined
  ) {}

  start(input: StartAgentKernelRunInput): Promise<AgentKernelRunResult> {
    if (this.active.has(input.id)) throw new Error(`Agent run is already active: ${input.id}`)
    const controller = new AbortController()
    const promise = this.execute(input, controller.signal).finally(() => {
      if (this.active.get(input.id)?.controller === controller) this.active.delete(input.id)
      try {
        input.toolRouter.releaseRun?.(input.id)
      } catch (error) {
        console.warn('[AgentRun] Could not release what the run was given:', error)
      }
      // A message the run ended before taking stays with the caller, who sends it next.
      this.steers.delete(input.id)
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

  /**
   * Queue a user message for a running run. It joins the transcript before the
   * next model request, so a stream or tool call already under way finishes
   * undisturbed. False when the run cannot take it at a safe boundary.
   */
  steer(runId: string, steer: AgentRunSteer): boolean {
    const active = this.active.get(runId)
    const phase = this.store.get(runId)?.phase
    if (!active || active.controller.signal.aborted || !phase || !STEERABLE_PHASES.has(phase)) {
      return false
    }
    const queue = this.steers.get(runId) ?? []
    if (!queue.some(({ id }) => id === steer.id)) this.steers.set(runId, [...queue, steer])
    return true
  }

  private applySteers(runId: string): ProviderChatMessage[] {
    const queue = this.steers.get(runId)
    if (!queue?.length) return []
    this.steers.delete(runId)
    return queue.map((steer) => {
      this.append(runId, 'run.steered', { ...steer.payload, steerId: steer.id })
      try {
        steer.onApplied?.()
      } catch (error) {
        console.warn('[AgentRun] Could not settle a steered message:', error)
      }
      return steer.message
    })
  }

  private hasPendingSteer(runId: string): boolean {
    return Boolean(this.steers.get(runId)?.length)
  }

  isActive(runId: string): boolean {
    return this.active.has(runId)
  }

  hasActiveRuns(): boolean {
    return this.active.size > 0
  }

  activeRunIds(): string[] {
    return [...this.active.keys()]
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
    const pending = this.store.getInteraction(interactionId)
    const before = pending ? (this.store.get(pending.runId)?.lastSequence ?? 0) : 0
    const interaction = this.store.resolveInteraction(interactionId, response, cancelled)
    const event = this.store.listEvents(interaction.runId, before, 1)[0]
    try {
      if (event) this.publish(event)
    } finally {
      // The response is durable already. An observer failure must not strand its waiter
      // or require another response (which the store correctly rejects as a duplicate).
      this.pendingResolvers.get(interactionId)?.resolve(interaction)
      this.pendingResolvers.delete(interactionId)
    }
    return interaction
  }

  /** Sends on an artifact's code as far as it has streamed; it is shown, never stored. */
  private draftArtifact(runId: string, toolCallId: string, call: ProviderToolCall): void {
    const args = call.function.arguments
    if (!args || typeof args !== 'object' || typeof args.code !== 'string') return
    try {
      this.publishArtifactDraft({
        runId,
        toolCallId,
        type: args.type === 'html' || args.type === 'svg' ? args.type : 'react',
        title: typeof args.title === 'string' ? args.title : '',
        code: args.code
      })
    } catch (error) {
      console.warn('[AgentRun] Could not send an artifact draft:', error)
    }
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
    return new Promise<PendingAgentInteraction>((resolve) => {
      const finish = (interaction: PendingAgentInteraction): void => {
        signal.removeEventListener('abort', abort)
        this.pendingResolvers.delete(id)
        resolve(interaction)
      }
      const abort = (): void => {
        const current = this.store.getInteraction(id)
        if (current?.status === 'pending') {
          try {
            this.resolveInteraction(id, { reason: 'run_cancelled' }, true)
          } catch (error) {
            const resolved = this.store.getInteraction(id)
            // Abort listeners have no caller to receive an observer error. Once the
            // cancellation is durable, finish it rather than crashing the event loop.
            if (resolved && resolved.status !== 'pending') finish(resolved)
            else throw error
          }
        } else if (current) finish(current)
      }
      signal.addEventListener('abort', abort, { once: true })
      // A subscriber may answer or cancel synchronously while receiving this event.
      // Install the waiter first so the persisted response cannot strand the run.
      this.pendingResolvers.set(id, { runId, resolve: finish })
      if (event) this.publish(event)
      if (signal.aborted) abort()
    })
  }

  /**
   * Lets a tool handler pause its run on a durable question to the user, such as the card that
   * confirms starting chats. The run resumes its tool once the user answers or the run stops.
   */
  async requestUserDecision(
    runId: string,
    request: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<PendingAgentInteraction> {
    const interaction = await this.suspendForInteraction(runId, 'question', request, signal)
    if (!signal.aborted) this.transition(runId, 'executing_tool')
    return interaction
  }

  private async executeAskUser(
    runId: string,
    title: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    startedAt: number
  ): Promise<ToolExecutionResult> {
    // Answers are keyed by question id; a question asked without one is numbered.
    const questions = Array.isArray(args.questions)
      ? args.questions.map((question: unknown, index) =>
          question && typeof question === 'object' && !(question as { id?: unknown }).id
            ? { ...question, id: `q${index + 1}` }
            : question
        )
      : args.questions
    const interaction = await this.suspendForInteraction(
      runId,
      'question',
      { ...args, questions },
      signal
    )
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

  /**
   * Waits, with no card, while the user clears a human check in the Browser panel: the step's
   * title says what to do, the panel opens on the page, and the run goes on once the check is
   * gone. It gives up after `HUMAN_CHECK_WAIT_MS`.
   */
  private async executeBrowserRequestHuman(
    runId: string,
    title: string,
    toolRouter: AgentKernelToolRouter,
    signal: AbortSignal,
    startedAt: number
  ): Promise<ToolExecutionResult> {
    const run = this.store.get(runId)
    const conversationId = run?.threadId ?? ''
    if (
      !conversationId ||
      !toolRouter.reserveBrowserForHumanCheck ||
      !toolRouter.waitForBrowserHumanCheck
    ) {
      return toolExecutionFailed({
        title,
        code: 'not_found',
        message: 'No browser session is open for the user to finish this check in',
        recoveryAction: 'change_strategy',
        startedAt
      })
    }
    let browserSessionId: string
    try {
      browserSessionId = await toolRouter.reserveBrowserForHumanCheck(conversationId)
    } catch (error) {
      return toolExecutionFailed({
        title,
        code: 'not_found',
        message:
          error instanceof Error ? error.message : 'The browser could not be held for the user',
        recoveryAction: 'change_strategy',
        startedAt
      })
    }
    const timeout = AbortSignal.timeout(HUMAN_CHECK_WAIT_MS)
    // Waiting on the user, as for a question: the chat shows as waiting and frees its run slot.
    this.transition(runId, 'awaiting_user')
    try {
      await toolRouter.waitForBrowserHumanCheck(
        conversationId,
        browserSessionId,
        AbortSignal.any([signal, timeout])
      )
      return toolExecutionSucceeded({
        title,
        data: { completed: true },
        modelContent:
          'The user cleared the check on the page. Call browser_observe now and continue from the fresh page state.',
        startedAt
      })
    } catch (error) {
      if (signal.aborted) {
        return toolExecutionFailed({
          title,
          code: 'cancelled',
          message: 'The run stopped while waiting for the user',
          status: 'cancelled',
          startedAt
        })
      }
      return toolExecutionFailed({
        title,
        code: timeout.aborted ? 'timeout' : 'not_found',
        message: timeout.aborted
          ? 'The user did not clear the check in time'
          : error instanceof Error
            ? error.message
            : 'The browser page is no longer available',
        recoveryAction: 'change_strategy',
        recovery:
          'Use a legitimate alternate source, or tell the user in one sentence what is still blocked. Do not retry or bypass the check.',
        startedAt
      })
    } finally {
      if (!signal.aborted) this.transition(runId, 'executing_tool')
      if (toolRouter.releaseBrowserHumanCheck) {
        await toolRouter
          .releaseBrowserHumanCheck(conversationId, browserSessionId)
          .catch(() => undefined)
      }
    }
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
The user approved Plan mode. The runtime has removed all project mutations, shell commands, MCP calls, artifacts, and child agents. Explore with the currently available read-only tools, ask focused questions when needed, and finish by calling present_plan with a verifiable contract. Do not implement yet.
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
  ): Promise<'approved' | 'denied' | 'denied_stop' | { refused: string }> {
    const decision = await this.decideTool(input, call, title, signal)
    if (decision === 'approved') {
      input.toolRouter.credentialApproved?.(call.name, call.arguments, {
        conversationId: input.threadId,
        runId: input.id,
        toolCallId: call.id
      })
    }
    return decision
  }

  /**
   * A call that uses a stored credential is a sensitive action: the permission mode decides it as
   * it decides any other, so Full access runs it without asking, and "Allow for this chat" covers
   * the same credential again. A use that breaks a credential rule is refused here, before any
   * card, whatever the mode.
   */
  private async decideTool(
    input: StartAgentKernelRunInput,
    call: AgentToolCall,
    title: string,
    signal: AbortSignal
  ): Promise<'approved' | 'denied' | 'denied_stop' | { refused: string }> {
    const catalog = currentCatalog(input)
    const context = { conversationId: input.threadId, runId: input.id, toolCallId: call.id }
    const credential = input.toolRouter.credentialApproval?.(call.name, call.arguments, context)
    if (credential && 'refused' in credential) return { refused: credential.refused }
    const routedAccess = input.toolRouter.requestedAccess?.(call.name, call.arguments, context)
    // Tools that change SideKick itself ask every time, even in full access, as do calls the
    // router marks so.
    const alwaysAsk =
      getAgentToolEntry(catalog, call.name)?.approval === 'always' || routedAccess === 'always'
    if (!alwaysAsk && !credential && !toolNeedsPolicyDecision(catalog, call.name)) {
      return 'approved'
    }
    const toolAccess = alwaysAsk
      ? 'confirm'
      : (routedAccess ?? toolRequestedAccess(catalog, call.name, call.arguments))
    const requestedAccess = credential ? 'confirm' : toolAccess
    const decision = alwaysAsk
      ? { effectiveAccess: 'confirm' as const }
      : resolvePermissionPolicy(input.permissionMode, requestedAccess)
    const safeArguments =
      input.toolRouter.safeArguments?.(call.name, call.arguments) ?? call.arguments
    const credentialFacts = credential ? { credential: credential.alias } : {}
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
        arguments: safeArguments,
        ...credentialFacts
      })
      return 'approved'
    }
    // A chat grant covers what the call does on its own, when that asks, and every credential it
    // uses; a call that would run unasked but for its credential needs only the credential's.
    const ownScope = alwaysAsk ? null : agentPermissionScope(call.name, call.arguments)
    const asksOnItsOwn =
      resolvePermissionPolicy(input.permissionMode, toolAccess).effectiveAccess === 'confirm'
    const scope = alwaysAsk
      ? null
      : credential
        ? !asksOnItsOwn
          ? { keys: credential.keys, label: credential.label }
          : ownScope
            ? {
                keys: [...ownScope.keys, ...credential.keys],
                label: `${ownScope.label}, with ${credential.label}`
              }
            : null
        : ownScope
    const grants = this.chatGrants.get(input.threadId)
    if (scope && grants && scope.keys.every((key) => grants.has(key))) {
      this.append(input.id, 'permission.resolved', {
        toolCallId: call.id,
        name: call.name,
        title,
        requestedAccess,
        effectiveAccess: 'confirm',
        mode: input.permissionMode,
        approved: true,
        source: 'chat_grant',
        decision: 'chat_grant',
        chatScope: scope.label,
        arguments: safeArguments,
        ...credentialFacts
      })
      return 'approved'
    }
    const preview = credential
      ? credential.preview
      : await input.toolRouter
          .approvalPreview?.(call.name, call.arguments, context)
          .catch(() => undefined)
    const interaction = await this.suspendForInteraction(
      input.id,
      'permission',
      {
        toolCallId: call.id,
        name: call.name,
        title: credential ? `Use ${credential.alias}: ${title}` : title,
        requestedAccess,
        mode: input.permissionMode,
        arguments: safeArguments,
        ...credentialFacts,
        ...(scope ? { chatScope: scope.label } : {}),
        ...(preview ? { preview } : {})
      },
      signal
    )
    const answer =
      interaction.status === 'resolved' ? agentPermissionDecision(interaction.response) : 'deny'
    if (answer === 'allow_chat' && scope) {
      // Only the scope computed here is granted; the response cannot name its own.
      const granted = this.chatGrants.get(input.threadId) ?? new Set<string>()
      for (const key of scope.keys) granted.add(key)
      this.chatGrants.set(input.threadId, granted)
    }
    if (answer === 'allow_once' || answer === 'allow_chat') return 'approved'
    if (credential) input.toolRouter.credentialDenied?.(call.name, call.arguments, context)
    return answer === 'deny_stop' ? 'denied_stop' : 'denied'
  }

  /**
   * Puts a reply SideKick stopped on record: what it said, why it was stopped, and every call it
   * had begun, refused, so the chat shows no call still pending and nothing runs.
   */
  private stopRunawayReply(
    input: StartAgentKernelRunInput,
    turn: AgentKernelModelTurn,
    runaway: ToolCallRunaway,
    previews: ReadonlyMap<string, string>,
    options: { stoppedWhileStreaming: boolean; separate: boolean }
  ): void {
    const stopped = { ...runaway, stoppedWhileStreaming: options.stoppedWhileStreaming }
    this.append(input.id, 'assistant.completed', {
      content: options.separate && turn.content ? `\n\n${turn.content}` : turn.content,
      thinking: turn.thinking,
      thinkingBlocks: [],
      toolCalls: [],
      usage: turn.usage,
      runaway: stopped,
      generationId: turn.generationId
    })
    this.append(input.id, 'usage.updated', turn.usage)
    input.goalController?.onUsage?.(turn.usage)
    const message =
      runaway.kind === 'repeated_call'
        ? `Not run: SideKick stopped the reply because it wrote the same ${runaway.toolName} call ${runaway.identicalCalls} times.`
        : `Not run: SideKick stopped the reply because it wrote ${runaway.toolCallCount} tool calls.`
    for (const [toolCallId, signature] of previews) {
      const name = String((JSON.parse(signature) as unknown[])[0] ?? '')
      this.append(input.id, 'tool.completed', {
        toolCallId,
        name,
        result: toolExecutionFailed({
          title: name.replaceAll('_', ' '),
          code: 'loop_detected',
          message,
          retryable: false,
          recoveryAction: 'change_strategy'
        })
      })
    }
    this.append(input.id, 'run.retrying', { reason: 'runaway_tool_calls', ...stopped })
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
    // Record the window the budget was computed against. A compaction that
    // fires early is almost always an unknown context length falling back to
    // the default, and the transcript should say so rather than look random.
    const contextLength = Number(input.promptContext?.contextLength)
    const contextReliable = input.promptContext?.contextReliable !== false
    this.append(input.id, 'compaction.completed', {
      previousMessageCount: messages.length,
      messageCount: validated.length,
      compacted: prepared.compacted,
      reason,
      ...(Number.isFinite(contextLength) && contextLength > 0 ? { contextLength } : {}),
      contextReliable,
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
    if (input.initialSteers?.length) this.steers.set(input.id, [...input.initialSteers])
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
    // A turn that follows a goal continuation or a steered message starts a new paragraph.
    let separateNextTurn = false
    // Tool rounds the model attempted after its goal was already complete.
    let toolRoundsAfterGoalComplete = 0
    // Tool rounds a sub-agent attempted after its tool budget was spent.
    let toolRoundsAfterBudgetSpent = 0
    let reportRequested = false
    let contextOverflowRetryAttempted = false
    let imageLimitRetryAttempted = false
    let outputLimitRetryAttempted = false
    let streamDropRetryAttempted = false
    let providerBusyRetries = 0
    // Whether any turn of this run wrote text; until one does, an empty reply is asked again once.
    let repliedWithText = false
    let emptyReplyRetryAttempted = false
    // A reply that ran away is stopped and the model told once; a second one ends the run.
    let runawayStopped = false
    // Learned from a provider's image-count rejection and enforced on every
    // later request, so one screenshot-heavy session does not fail the same way
    // turn after turn. Seeded from what earlier runs on this model learned.
    const learnedKey = learnedLimitKey(input.provider, input.model)
    // A window an earlier run saw the provider report outranks configuration,
    // so the very first request of a later run is already budgeted correctly.
    const rememberedContextLength = learnedContextLengths.get(learnedKey)
    let imageBudget: number | null = learnedImageLimits.get(learnedKey) ?? null
    let activeRequest = input.request
    /**
     * Believe the provider over the configuration when it states its own
     * window, and shrink the output reservation to match: a 32k reservation
     * inside a 49k window leaves almost nothing for the conversation.
     */
    const applyReportedContextLength = (reported?: number): void => {
      if (!reported || !Number.isFinite(reported) || reported <= 0) return
      const configured = Number(activeRequest.target.contextLength) || reported
      if (reported >= configured) return
      learnedContextLengths.set(learnedKey, reported)
      // The smaller window gets the default share; never more than was asked for before.
      const maxOutputTokens = Math.min(
        resolveMaxOutputTokens(reported),
        activeRequest.maxOutputTokens ?? Number.POSITIVE_INFINITY
      )
      activeRequest = {
        ...activeRequest,
        maxOutputTokens,
        target: { ...activeRequest.target, contextLength: reported }
      }
      activeContextManager?.applyContextLength?.(reported, maxOutputTokens)
      this.append(input.id, 'run.retrying', {
        reason: 'context_length_corrected',
        contextLength: reported,
        configuredContextLength: configured,
        maxOutputTokens
      })
    }
    /** Never ask for a longer reply than the provider said it allows. */
    const applyOutputLimit = (limit: number): void => {
      if ((activeRequest.maxOutputTokens ?? Number.POSITIVE_INFINITY) <= limit) return
      activeRequest = { ...activeRequest, maxOutputTokens: limit }
    }
    let activeContextManager = input.contextManager
    let completionHooksRun = false
    // The answer a verification request held back. When the pass that follows
    // leaves the workspace as it was, that answer stays the response and the
    // pass's closing reply is only a note on the verification.
    let deferredAnswer: { content: string; contentBefore: string; revision: number } | undefined

    const runProjectHooks = async (
      commands: string[] | undefined,
      title: string
    ): Promise<void> => {
      if (
        input.profile.executionMode !== 'plan' &&
        getAgentToolEntry(currentCatalog(input), 'shell')
      ) {
        // Snapshot before waiting for approval; changes to settings cannot replace reviewed commands.
        const hooks = [...(commands ?? [])].slice(0, 10)
        for (const command of hooks) {
          const call: AgentToolCall = { id: randomUUID(), name: 'shell', arguments: { command } }
          const startedAt = Date.now()
          this.append(input.id, 'tool.pending', {
            toolCallId: call.id,
            name: call.name,
            title,
            arguments: call.arguments
          })
          const approval = await this.suspendForInteraction(
            input.id,
            'permission',
            {
              toolCallId: call.id,
              name: call.name,
              title,
              arguments: call.arguments,
              requestedAccess: 'confirm',
              mode: 'always-ask',
              workspaceRoot: input.workspaceRoot
            },
            signal
          )
          if (
            signal.aborted ||
            approval.status !== 'resolved' ||
            approval.response?.approved !== true
          ) {
            this.append(input.id, 'tool.completed', {
              toolCallId: call.id,
              name: call.name,
              result: toolExecutionFailed({
                title,
                code: 'permission_denied',
                message: `${title} was not approved`,
                status: 'denied',
                startedAt
              })
            })
            throw new Error(`${title} was not approved; the run was stopped`)
          }
          this.transition(input.id, 'executing_tool')
          this.append(input.id, 'tool.running', {
            toolCallId: call.id,
            name: call.name,
            title,
            arguments: call.arguments
          })
          const result = await this.tools.execute(
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
                  this.append(input.id, 'tool.output.delta', { toolCallId: call.id, stream, chunk })
              }
            },
            ((args, context) =>
              input.toolRouter.execute('shell', args, context)) as AgentToolExecutor
          )
          this.append(input.id, 'tool.completed', { toolCallId: call.id, name: call.name, result })
          if (result.status !== 'success')
            throw new Error(`${title} failed; inspect its output before retrying`)
          messages.push(
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: call.id,
                  type: 'function',
                  function: { name: 'shell', arguments: JSON.stringify(call.arguments) }
                }
              ]
            },
            { role: 'tool', tool_call_id: call.id, content: result.modelContent }
          )
        }
      }
    }
    // Files the user named come back as reads the model already made, so its first turn starts
    // from their contents instead of spending a round opening them. They run through the read
    // tool, which records the receipts an edit of those files needs.
    const preloadReads = async (paths: string[] | undefined): Promise<void> => {
      if (!input.workspaceRoot || !getAgentToolEntry(currentCatalog(input), 'read')) return
      for (const path of [...new Set(paths ?? [])].slice(0, MAX_PRELOADED_READS)) {
        if (signal.aborted) return
        const call: AgentToolCall = { id: randomUUID(), name: 'read', arguments: { path } }
        const title = `Read ${path}`
        this.append(input.id, 'tool.pending', {
          toolCallId: call.id,
          name: call.name,
          title,
          arguments: call.arguments
        })
        this.transition(input.id, 'executing_tool')
        this.append(input.id, 'tool.running', {
          toolCallId: call.id,
          name: call.name,
          title,
          arguments: call.arguments
        })
        const result = await this.tools.execute(
          {
            catalog: currentCatalog(input),
            call,
            title,
            context: {
              runId: input.id,
              conversationId: input.threadId,
              workspaceRoot: input.workspaceRoot,
              signal
            }
          },
          ((args, context) => input.toolRouter.execute('read', args, context)) as AgentToolExecutor
        )
        this.append(input.id, 'tool.completed', { toolCallId: call.id, name: call.name, result })
        messages.push(
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: call.id,
                type: 'function',
                function: { name: 'read', arguments: JSON.stringify(call.arguments) }
              }
            ]
          },
          { role: 'tool', tool_call_id: call.id, content: result.modelContent }
        )
      }
    }
    if (rememberedContextLength) applyReportedContextLength(rememberedContextLength)
    const rememberedOutputLimit = learnedOutputLimits.get(learnedKey)
    if (rememberedOutputLimit) applyOutputLimit(rememberedOutputLimit)
    try {
      await runProjectHooks(input.projectStartCommands, 'Project start hook')
      if (input.preloadReads?.length) await preloadReads(input.preloadReads)
      this.transition(started.id, 'streaming')
      while (!signal.aborted) {
        const steered = this.applySteers(input.id)
        if (steered.length) {
          messages = [...messages, ...steered]
          if (finalContent) separateNextTurn = true
        }
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

        // A sub-agent whose tool budget is used up gets one more turn to report.
        // Refusing its tool calls was not enough: a model kept asking until the
        // run ended on an empty reply, and the agent got no report at all. The
        // turn is told so, and offered no tools where the provider allows it;
        // Anthropic rejects a transcript holding tool calls without definitions.
        const reportOnly =
          Boolean(input.parentRunId) && toolRounds >= Math.max(1, input.maxToolRounds)
        if (reportOnly && !reportRequested) {
          reportRequested = true
          messages = [
            ...messages,
            {
              role: 'user',
              content:
                'Your tool budget for this task is used up, and no more tool calls will run. Reply now, in text, with your report for the agent that delegated this task: what you found, with its sources, and what is left unchecked.'
            }
          ]
          requestMessages = messages
        }
        const toolDefinitions =
          reportOnly && input.provider !== 'anthropic'
            ? []
            : getAgentToolDefinitions(currentCatalog(input))
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
        if (imageBudget !== null) {
          const budgeted = enforceImageBudget(requestMessages, imageBudget)
          if (budgeted.removed > 0) {
            requestMessages = budgeted.messages
            messages = requestMessages
          }
        }

        // The model's reply limit, cut to what the window has left after this request.
        const replyLimit =
          activeContextManager?.replyLimit?.(
            requestMessages,
            toolDefinitions,
            activeRequest.maxOutputTokens
          ) ?? activeRequest.maxOutputTokens
        let pendingContent = separateNextTurn ? '\n\n' : ''
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
        // One reply wrote 784 tool calls for five minutes, 781 of them the same click, until its
        // output limit cut it off. A reply that runs away is stopped while it streams.
        const runawayGuard = new ToolCallRunawayGuard()
        const stopReply = new AbortController()
        let runaway: ToolCallRunaway | undefined
        const guardKey = (call: ProviderToolCall, position: number): string =>
          call.id || `tool_index_${call.index ?? position}`
        try {
          sampled = await abortablePromise(
            this.sample(
              {
                ...activeRequest,
                maxOutputTokens: replyLimit,
                messages: requestMessages,
                tools: toolDefinitions
              },
              AbortSignal.any([signal, stopReply.signal]),
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
                for (const [position, call] of (chunk.message?.tool_calls ?? []).entries()) {
                  runaway ??= runawayGuard.begin(guardKey(call, position))
                  const id = call.id || `tool_index_${call.index ?? 0}`
                  if (call.function.name === 'create_artifact')
                    this.draftArtifact(input.id, id, call)
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
                for (const [position, call] of (chunk.message?.closed_tool_calls ?? []).entries()) {
                  runaway ??= runawayGuard.close(
                    guardKey(call, position),
                    call.function.name,
                    call.function.arguments
                  )
                }
                if (runaway) {
                  acceptingChunks = false
                  stopReply.abort()
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
        sampled = {
          ...sampled,
          turn: { ...sampled.turn, toolCalls: uniqueToolCallIds(sampled.turn.toolCalls) }
        }
        // A reply that arrived whole, or was not stopped while it streamed, is checked once.
        runaway ??=
          stopReply.signal.aborted || !sampled.result.ok
            ? undefined
            : runawayGuard.closeAll(sampled.turn.toolCalls)
        if (runaway) {
          this.stopRunawayReply(input, sampled.turn, runaway, previewSignatures, {
            stoppedWhileStreaming: stopReply.signal.aborted,
            separate: separateNextTurn
          })
          if (runawayStopped) {
            throw new AgentToolLoopError(
              'The model wrote the same tool calls over and over again after it was stopped once'
            )
          }
          runawayStopped = true
          const partial =
            separateNextTurn && sampled.turn.content
              ? `\n\n${sampled.turn.content}`
              : sampled.turn.content
          finalContent += partial
          separateNextTurn = false
          messages = [
            ...requestMessages,
            ...(sampled.turn.content.trim()
              ? [{ role: 'assistant' as const, content: sampled.turn.content }]
              : []),
            { role: 'user', content: runawayNotice(runaway) }
          ]
          continue
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
            applyReportedContextLength(overflow.contextLength)
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
          const outputLimit = providerOutputLimitError(providerError)
          if (
            outputLimit &&
            !outputLimitRetryAttempted &&
            outputLimit.maxOutputTokens < (replyLimit ?? Number.POSITIVE_INFINITY)
          ) {
            outputLimitRetryAttempted = true
            learnedOutputLimits.set(learnedKey, outputLimit.maxOutputTokens)
            applyOutputLimit(outputLimit.maxOutputTokens)
            this.append(input.id, 'run.retrying', {
              reason: 'output_limit_exceeded',
              maxOutputTokens: outputLimit.maxOutputTokens,
              requestedOutputTokens: replyLimit
            })
            continue
          }
          const imageLimit = providerImageLimitError(providerError)
          if (imageLimit && !imageLimitRetryAttempted) {
            imageLimitRetryAttempted = true
            // A provider that names no number tells us only that what we sent
            // was too much, so try one fewer than we actually sent rather than
            // a guess. When even one image is refused this reaches zero, which
            // is the honest reading for a model that cannot accept images.
            const sentImages = countTranscriptImages(requestMessages)
            imageBudget =
              imageLimit.maxImages ?? Math.max(0, Math.min(FALLBACK_IMAGE_BUDGET, sentImages - 1))
            const budgeted = enforceImageBudget(requestMessages, imageBudget)
            if (budgeted.removed > 0) {
              learnedImageLimits.set(learnedKey, imageBudget)
              this.append(input.id, 'run.retrying', {
                reason: 'image_limit_exceeded',
                maxImages: imageBudget,
                removedImages: budgeted.removed,
                sentImages
              })
              messages = budgeted.messages
              continue
            }
          }
          // Tools run only once their whole turn has arrived, so a stream that broke off ran none
          // of this turn's calls, and earlier turns' results are already in the transcript. The
          // partial turn is discarded and the same request asked again, once.
          if (providerStreamDropped(providerError) && !streamDropRetryAttempted) {
            streamDropRetryAttempted = true
            this.append(input.id, 'run.retrying', {
              reason: 'stream_dropped',
              discardsPartialTurn: true,
              delayMs: STREAM_DROP_RETRY_DELAY_MS,
              error: providerError
            })
            await abortablePromise(
              new Promise((resolve) => setTimeout(resolve, STREAM_DROP_RETRY_DELAY_MS)),
              signal,
              'Agent run cancelled'
            )
            continue
          }
          const status = sampled.result.status
          const retryAfterMs = (sampled.result.retryAfter ?? 0) * 1_000
          if (
            status !== undefined &&
            PROVIDER_BUSY_STATUSES.has(status) &&
            providerBusyRetries < PROVIDER_BUSY_RETRY_DELAYS_MS.length &&
            retryAfterMs <= PROVIDER_RETRY_AFTER_LIMIT_MS &&
            !providerQuotaExhausted(sampled.result)
          ) {
            const scheduledMs = PROVIDER_BUSY_RETRY_DELAYS_MS[providerBusyRetries++]
            const delayMs = retryAfterMs > 0 ? retryAfterMs : scheduledMs
            // An overloaded server can fail a reply it has begun; as for a dropped stream, what
            // it streamed is not part of the reply.
            this.append(input.id, 'run.retrying', {
              reason: 'provider_unavailable',
              discardsPartialTurn: true,
              status,
              attempt: providerBusyRetries,
              delayMs,
              error: providerError
            })
            await abortablePromise(
              new Promise((resolve) => setTimeout(resolve, delayMs)),
              signal,
              'Agent run cancelled'
            )
            continue
          }
          throw new ProviderRequestError(providerError, sampled.result.status, sampled.result.code)
        }
        providerBusyRetries = 0
        contextOverflowRetryAttempted = false
        imageLimitRetryAttempted = false
        outputLimitRetryAttempted = false
        streamDropRetryAttempted = false
        const turn = sampled.turn
        // Some servers (LM Studio among them) report a turn the output limit cut off as finished
        // normally, even `tool_calls`; a turn that used its whole allowance was cut off whatever
        // the reason says.
        const stoppedForLength = isOutputLimitStop(turn.usage.doneReason)
        const hitOutputLimit =
          stoppedForLength || Boolean(replyLimit && turn.usage.completionTokens >= replyLimit)
        const truncatedToolBatch = turn.toolCalls.length > 0 && hitOutputLimit
        // What the journal keeps about a cut, so a diagnostics export can say what cut it off.
        const cutOff: ToolBatchCutOff | undefined = truncatedToolBatch
          ? {
              trigger: stoppedForLength ? 'stop_reason' : 'used_allowance',
              doneReason: turn.usage.doneReason,
              completionTokens: turn.usage.completionTokens,
              ...(replyLimit ? { replyLimit } : {}),
              ...(activeRequest.maxOutputTokens
                ? { maxOutputTokens: activeRequest.maxOutputTokens }
                : {}),
              toolCallCount: turn.toolCalls.length
            }
          : undefined
        const estimatedPromptTokens = activeContextManager?.observeUsage?.(
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
          separateNextTurn && turn.content ? `\n\n${turn.content}` : turn.content
        separateNextTurn = false
        if (turn.content.trim()) repliedWithText = true

        // A reply the output limit cut off while the model was still thinking produced nothing,
        // and is not an answer. As in Codex, the turn ends with that reason rather than completing
        // empty; the model is not told to cut its thinking short.
        if (
          !turn.toolCalls.length &&
          !turn.content.trim() &&
          !finalContent.trim() &&
          hitOutputLimit
        ) {
          const limit = replyLimit
          const cutByRoom = Boolean(
            limit && activeRequest.maxOutputTokens && limit < activeRequest.maxOutputTokens
          )
          throw new Error(
            `The model reached its output limit${limit ? ` of ${limit.toLocaleString('en-US')} tokens` : ''} while still thinking, before it answered or used a tool. ${
              cutByRoom
                ? "The chat had little room left in the model's context for a reply; ask it to continue."
                : "Raise the model's maximum output in Settings → Providers, or ask it to continue."
            }`
          )
        }

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
        const completionHooksPending =
          !completionHooksRun &&
          input.profile.executionMode === 'act' &&
          input.profile.surface === 'conversation' &&
          !input.goalController &&
          (!input.planController || input.planController.stage() === 'inactive') &&
          !turn.toolCalls.length &&
          verificationDecision?.continue !== true &&
          Boolean(input.projectCompletionCommands?.length) &&
          Boolean(getAgentToolEntry(currentCatalog(input), 'shell'))
        if (verificationDecision) {
          this.append(input.id, 'verification.updated', {
            summary: verificationDecision.summary
          })
        }
        const provisional =
          completionHooksPending ||
          needsResearchSource ||
          verificationDecision?.continue === true ||
          planDecision?.continue === true ||
          Boolean(planDecision?.error)
        const closesVerification = Boolean(deferredAnswer && !turn.toolCalls.length && !provisional)
        // A reply that changed nothing is a note on the answer it followed. When that answer was
        // empty (the model went straight to checking), the reply is the answer.
        const verificationNote =
          closesVerification &&
          Boolean(deferredAnswer?.content.trim()) &&
          verificationDecision?.summary.currentRevision === deferredAnswer?.revision
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
          ...(cutOff ? { outputLimit: cutOff } : {}),
          generationId: turn.generationId,
          provisional,
          ...(verificationNote ? { verificationNote: true } : {})
        })
        // The estimate beside the real count lets the next run start calibrated.
        this.append(input.id, 'usage.updated', {
          ...turn.usage,
          ...(typeof estimatedPromptTokens === 'number' ? { estimatedPromptTokens } : {})
        })
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

        if (verificationNote && deferredAnswer) {
          finalContent = deferredAnswer.contentBefore + deferredAnswer.content
          finalThinking += turn.thinking
        } else if (!provisional) {
          finalContent += projectedTurnContent
          finalThinking += turn.thinking
        }
        const finalResponse =
          verificationNote && deferredAnswer ? deferredAnswer.content : turn.content
        if (closesVerification) deferredAnswer = undefined

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
            deferredAnswer = {
              content: projectedTurnContent,
              contentBefore: finalContent,
              revision: verificationDecision.summary.currentRevision
            }
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
              finalResponse,
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
              separateNextTurn = true
              continue
            }
          }
          if (completionHooksPending) {
            completionHooksRun = true
            await runProjectHooks(input.projectCompletionCommands, 'Project completion hook')
            messages.push({
              role: 'user',
              content:
                'The approved completion hooks finished. Inspect their results, reverify any changed workspace state, then give the final response. Do not repeat the hooks.'
            })
            this.transition(input.id, 'streaming')
            continue
          }
          // A message the user sent during this last turn deserves a reply of its own.
          if (this.hasPendingSteer(input.id)) continue
          // A run that would end without having written any text, its last reply empty or only
          // thinking, has no answer. As in Gemini CLI, that reply is asked for again once, and a
          // second ends the run with the reason rather than completing empty.
          if (!repliedWithText) {
            const onlyThought = Boolean(turn.thinking.trim())
            if (emptyReplyRetryAttempted) {
              throw new Error(
                `The model ended its reply ${onlyThought ? 'after only thinking, ' : ''}without an answer, twice. Ask it again, or choose another model.`
              )
            }
            emptyReplyRetryAttempted = true
            this.append(input.id, 'run.retrying', { reason: 'empty_reply', onlyThought })
            // Providers refuse an assistant message with nothing in it.
            messages = requestMessages
            continue
          }
          this.transition(input.id, 'completed')
          return {
            runId: input.id,
            phase: 'completed',
            content: finalContent,
            finalResponse,
            thinking: finalThinking,
            messages,
            toolRounds
          }
        }

        toolRounds++
        // A sub-agent never asks to go on: nobody sees its questions while the
        // agent that delegated to it waits, so asking deadlocked both. Past its
        // budget its tools are refused and it reports what it has.
        const toolBudgetSpent =
          Boolean(input.parentRunId) && toolRounds > Math.max(1, input.maxToolRounds)
        if (toolBudgetSpent) toolRoundsAfterBudgetSpent++
        else if (toolRounds > Math.max(1, input.maxToolRounds)) {
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
        // Decided before the batch runs, so the call that completes the goal
        // still executes and only work requested after completion is refused.
        const goalAlreadyComplete = input.goalController?.isComplete?.() === true
        if (goalAlreadyComplete) toolRoundsAfterGoalComplete++
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
        if (cutOff)
          this.append(input.id, 'run.retrying', { reason: 'truncated_tool_batch', ...cutOff })
        const preExecuted = new Map<string, ToolExecutionResult>()
        // Decisions already taken for calls that were authorized ahead of running together.
        const preAuthorized = new Map<
          string,
          Awaited<ReturnType<AgentRunKernel['authorizeTool']>>
        >()
        const runPrepared = async (
          prepared: (typeof preparedBatch)[number]
        ): Promise<ToolExecutionResult> => {
          this.transition(input.id, 'executing_tool')
          this.append(input.id, 'tool.running', {
            toolCallId: prepared.call.id,
            name: prepared.call.name,
            title: prepared.presentation.title || prepared.title,
            arguments: prepared.safeArguments,
            presentation: prepared.presentation
          })
          return this.tools.execute(
            {
              catalog: currentCatalog(input),
              call: prepared.call,
              title: prepared.title,
              context: {
                runId: input.id,
                conversationId: input.threadId,
                workspaceRoot: input.workspaceRoot,
                signal,
                onOutput: ({ chunk, stream }) =>
                  this.append(input.id, 'tool.output.delta', {
                    toolCallId: prepared.call.id,
                    stream,
                    chunk
                  })
              }
            },
            ((args, context) =>
              input.toolRouter.execute(prepared.call.name, args, context)) as AgentToolExecutor
          )
        }
        const invalidPrepared = (
          prepared: (typeof preparedBatch)[number]
        ): ToolExecutionResult | undefined =>
          validatePreparedAgentToolCall(
            currentCatalog(input),
            prepared.call,
            prepared.title,
            Date.now(),
            prepared.prepared.repairs,
            prepared.prepared.argumentSnapshotFailed
          ) ?? undefined
        for (let callIndex = 0; callIndex < preparedBatch.length; callIndex++) {
          const item = preparedBatch[callIndex]
          // A stop starts no more calls, but every call that ran together with others still
          // records how it ended.
          if (signal.aborted && !preExecuted.has(item.call.id)) continue
          const { prepared, call, title, safeArguments } = item
          const entry = getAgentToolEntry(currentCatalog(input), call.name)
          const concurrency = entry?.concurrency
          if (
            !truncatedToolBatch &&
            !goalAlreadyComplete &&
            !toolBudgetSpent &&
            (concurrency === 'parallel' || concurrency === 'approved-parallel') &&
            !preExecuted.has(call.id) &&
            !preAuthorized.has(call.id)
          ) {
            const group = [item]
            while (callIndex + group.length < preparedBatch.length) {
              const sibling = preparedBatch[callIndex + group.length]
              const siblingEntry = getAgentToolEntry(currentCatalog(input), sibling.call.name)
              if (siblingEntry?.concurrency !== concurrency) break
              group.push(sibling)
            }
            // Each call that needs the user's approval is asked about in turn,
            // before any runs; only the approved ones then run together.
            const runnable: typeof group = []
            for (const member of group) {
              if (signal.aborted) break
              const invalid = invalidPrepared(member)
              if (invalid) {
                preExecuted.set(member.call.id, invalid)
                continue
              }
              if (concurrency === 'approved-parallel') {
                if (group.length === 1) break
                const decision = await this.authorizeTool(input, member.call, member.title, signal)
                preAuthorized.set(member.call.id, decision)
                if (decision === 'denied_stop') break
                if (decision !== 'approved') continue
              }
              runnable.push(member)
            }
            if (concurrency === 'parallel' || runnable.length > 1) {
              await Promise.all(
                runnable.map(async (member) => {
                  preExecuted.set(member.call.id, await runPrepared(member))
                })
              )
            }
          }
          const startedAt = Date.now()
          let result: ToolExecutionResult
          let authorization: Awaited<ReturnType<AgentRunKernel['authorizeTool']>> | undefined
          let stopAfterDenial = false
          const parallelResult = preExecuted.get(call.id)
          if (parallelResult) {
            result = parallelResult
          } else if (cutOff) {
            result = cutOffToolResult(title, cutOff, startedAt, call.name)
          } else if (goalAlreadyComplete) {
            result = toolExecutionFailed({
              title,
              code: 'conflict',
              message: 'The goal is already complete, so this tool was not run.',
              retryable: false,
              recoveryAction: 'stop',
              recovery:
                'Do not redo or extend the work and do not call tools. Reply to the user with one brief closing message.',
              startedAt
            })
          } else if (toolBudgetSpent) {
            result = toolExecutionFailed({
              title,
              code: 'conflict',
              message: 'This task has used its tool budget, so this tool was not run.',
              retryable: false,
              recoveryAction: 'stop',
              recovery:
                'Do not call tools. Reply now with what you found, and say what is left unchecked, for the agent that delegated this task.',
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
              prepared.repairs,
              prepared.argumentSnapshotFailed
            )
            if (invalid) result = invalid
            else if (call.name === 'ask_user') {
              result = await this.executeAskUser(input.id, title, call.arguments, signal, startedAt)
            } else if (call.name === 'browser_request_human') {
              result = await this.executeBrowserRequestHuman(
                input.id,
                title,
                input.toolRouter,
                signal,
                startedAt
              )
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
            } else if (
              (authorization =
                preAuthorized.get(call.id) ??
                (await this.authorizeTool(input, call, title, signal))) !== 'approved'
            ) {
              stopAfterDenial = authorization === 'denied_stop'
              result =
                typeof authorization === 'object'
                  ? toolExecutionFailed({
                      title,
                      code: 'permission_denied',
                      message: authorization.refused,
                      status: 'denied',
                      retryable: false,
                      recoveryAction: 'change_strategy',
                      startedAt
                    })
                  : toolExecutionFailed({
                      title,
                      code: 'permission_denied',
                      message: stopAfterDenial
                        ? 'Operation denied by the user, who also stopped the run'
                        : 'Operation denied by the user',
                      status: 'denied',
                      startedAt
                    })
            } else {
              result = await runPrepared(item)
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
            ),
            ...(cutOff ? { outputLimit: cutOff } : {})
          })
          lastToolMessage = {
            role: 'tool',
            tool_call_id: call.id,
            content: result.modelContent,
            ...(result.media?.length ? { media: result.media } : {})
          }
          messages.push(lastToolMessage)
          // "Deny and stop" ends the run once the refusal is on record.
          if (stopAfterDenial) this.stop(input.id)
        }
        if (callStopReason) throw new AgentToolLoopError(callStopReason)
        if (toolRoundsAfterGoalComplete >= 2 || toolRoundsAfterBudgetSpent >= 2) {
          // Refused once and asked for tools again: the outcome is already in
          // the transcript, so end on it rather than loop.
          this.transition(input.id, 'completed')
          return {
            runId: input.id,
            phase: 'completed',
            content: finalContent,
            finalResponse: finalContent,
            thinking: finalThinking,
            messages,
            toolRounds
          }
        }
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
        }
        if (turnGuard.stopReason) throw new AgentToolLoopError(turnGuard.stopReason)
        const verificationReminder = lastToolMessage
          ? input.verificationController?.afterToolRound?.()
          : undefined
        if (verificationReminder && lastToolMessage) {
          lastToolMessage.content = `${lastToolMessage.content || ''}\n${verificationReminder}`
        }
        if (!signal.aborted) this.transition(input.id, 'streaming')
      }
      throw new DOMException('Agent run cancelled', 'AbortError')
    } catch (error) {
      const failure = classifyAgentKernelFailure(error, signal.aborted)
      this.transition(input.id, failure.phase, failure.error)
      return {
        runId: input.id,
        phase: failure.phase,
        content: finalContent,
        finalResponse: '',
        thinking: finalThinking,
        messages,
        toolRounds,
        error: failure.message
      }
    }
  }
}
