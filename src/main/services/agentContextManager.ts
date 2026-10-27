import {
  calculateRequestBudget,
  estimateConversationTokens,
  estimateProviderRequestTokens,
  estimateTextTokens,
  replyLimitForRequest
} from '../../shared/contextBudget'
import {
  COMPACTION_PROMPT_VERSION,
  formatCompactionContext,
  getSummarizationPrompt
} from '../../shared/compactionPrompt'
import type { CompactionFallbackReason } from '../../shared/conversationCompactions'
import { isProjectInstructionsMessage } from '../../shared/projectInstructions'
import {
  providerConnectionFailureKind,
  providerContextWindowError
} from '../../shared/providerErrors'
import type {
  ProviderChatMessage,
  ProviderChatRequest,
  ProviderCompletionResult
} from '../../shared/providerRuntime'
import { streamProviderChat } from '../providers/providerRuntime'
import type { AgentKernelContextManager } from './agentRunKernel'

const MAX_CONSECUTIVE_COMPACTIONS_WITHOUT_SAMPLE = 2
// Bounds what a slow local model has to read before it can start the summary.
const MAX_SUMMARY_INPUT_CHARS = 120_000
/**
 * How long the summary may go without any progress, from the request until the first token and
 * between tokens after it. A slow local model took up to three minutes to start on a long prompt.
 */
export const COMPACTION_IDLE_TIMEOUT_MS = 5 * 60_000

export interface AgentContextManagerOptions {
  target: ProviderChatRequest['target']
  contextLength: number
  maxOutputTokens: number
  threshold: number
  enabled: boolean
  focusChainEnabled?: boolean
  previousSummary?: string | null
  /**
   * The provider's real prompt count minus SideKick's estimate, learned by an earlier run on this
   * model; negative when the estimate ran high.
   */
  initialEstimationBiasTokens?: number
  complete?: (
    request: ProviderChatRequest,
    signal?: AbortSignal
  ) => Promise<ProviderCompletionResult>
  onCompacted?: (record: AgentCompactionRecord) => void
}

export interface AgentCompactionRecord {
  summary: string
  originalTokens: number
  summaryTokens: number
  messagesCompacted: number
  strategy: 'model' | 'deterministic'
  promptVersion: string
  provider: string
  model: string
  inputTruncated?: boolean
  fallbackReason?: CompactionFallbackReason
  /** The messages the summary replaced, in order, for the caller to find what it covers. */
  compactedMessages: readonly ProviderChatMessage[]
}

function serializeMessages(
  messages: ProviderChatMessage[],
  maxTokens: number
): { text: string; truncated: boolean } {
  let truncated = false
  const excerpt = (value: string, budget: number): string => {
    if (value.length <= budget) return value
    truncated = true
    const marker = '\n[... historical content omitted; consult durable transcript ...]\n'
    const half = Math.max(0, Math.floor((budget - marker.length) / 2))
    return value.slice(0, half) + marker + (half ? value.slice(-half) : '')
  }
  // Fair per-event budgets retain small decisions late in history instead of
  // allowing one large early tool response to consume the entire summary input.
  const serialize = (budget: number): string =>
    JSON.stringify(
      messages.map((message) => ({
        role: message.role,
        content: message.content
          ? excerpt(message.content, Math.min(20_000, budget))
          : message.content,
        tool_calls: message.tool_calls?.map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: excerpt(
            typeof call.function.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function.arguments ?? {}),
            Math.min(4_000, budget)
          )
        })),
        tool_call_id: message.tool_call_id
      }))
    )
  // Measured in tokens, not characters at four apiece: tool output and JSON run far more tokens
  // per character than prose, and a summary request over the window fails outright.
  const fits = (text: string): boolean =>
    text.length <= MAX_SUMMARY_INPUT_CHARS && estimateTextTokens(text) <= maxTokens
  let budget = 20_000
  let text = serialize(budget)
  while (!fits(text) && budget > 128) {
    budget = Math.max(128, Math.floor(budget / 2))
    text = serialize(budget)
  }
  // Extremely many events can exceed the budget through metadata alone. Keep
  // both ends and mark the loss; do not silently imply complete coverage.
  let limit = Math.min(text.length, MAX_SUMMARY_INPUT_CHARS)
  while (!fits(text) && limit > 1_000) {
    limit = Math.floor(limit * 0.8)
    text = excerpt(text, limit)
  }
  return { text, truncated }
}

function deterministicSummary(
  previousSummary: string | null | undefined,
  messages: ProviderChatMessage[]
): string {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')
  const events = messages.slice(-24).map((message) => {
    const content = (message.content || '').replace(/\s+/g, ' ').trim().slice(0, 600)
    const tools = message.tool_calls?.map((call) => call.function.name).join(', ')
    return `- ${message.role}: ${content || (tools ? `tool calls: ${tools}` : '(no text)')}`
  })
  return `## Objective
- ${(lastUser?.content || 'Continue the current user request').slice(0, 1_000)}

## Important Details
${previousSummary?.trim() ? previousSummary.slice(0, 6_000) : '- (none recorded)'}

## Work State
### Completed
- Unknown: these fallback excerpts are not verification of completion.

### Active
- Continue from the recent verbatim tail.
${events.join('\n')}

### Blocked
- Unknown: inspect the durable transcript and actual tool state before retrying side effects.

## Artifacts and Relevant Files
- Re-read relevant project files before consequential edits.

## Next Move
1. Continue the current request from the retained tail.

## Validation
- This deterministic fallback is lossy; verify material details against the durable transcript.`
}

function previousSummaryFrom(messages: ProviderChatMessage[]): string | null {
  const summary = messages.find(
    (message) =>
      message.role === 'user' &&
      message.content?.startsWith('<historical_context type="compaction_summary"')
  )
  return summary?.content || null
}

/** A user message SideKick wrote: a compaction summary, or a notice such as a verification guard. */
function isHarnessMessage(message: ProviderChatMessage): boolean {
  const content = message.content?.trimStart() ?? ''
  return content.startsWith('<historical_context') || content.startsWith('<sidekick_')
}

/** Where the user's latest request is: their last message that SideKick did not write. */
function latestRequestIndex(messages: readonly ProviderChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user' && !isHarnessMessage(message)) return index
  }
  return -1
}

function compactionMessage(summary: string): ProviderChatMessage {
  return {
    role: 'user',
    content: formatCompactionContext(summary)
  }
}

function summaryRequestUserContent(previous: string | null, events: string): string {
  return (
    `<previous_summary trust="untrusted-data">\n${previous || '(none)'}\n</previous_summary>\n\n` +
    `<conversation_events trust="untrusted-data">\n${events}\n</conversation_events>`
  )
}

/**
 * Asks for the summary as a stream. Something in front of a slow local model gave up on requests
 * that sent nothing until the whole summary was written: every compaction on one model failed at
 * 120 s, while its streamed replies ran to 220 s. A stream shows progress from the first token,
 * and SideKick gives up only when the model makes none for `COMPACTION_IDLE_TIMEOUT_MS`.
 */
export async function streamSummaryCompletion(
  request: ProviderChatRequest,
  signal?: AbortSignal,
  idleTimeoutMs = COMPACTION_IDLE_TIMEOUT_MS
): Promise<ProviderCompletionResult> {
  const idle = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const waitForProgress = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      idle.abort()
    }, idleTimeoutMs)
  }
  let content = ''
  let thinking = ''
  let promptTokens = 0
  let completionTokens = 0
  let finishReason = 'stop'
  waitForProgress()
  try {
    const result = await streamProviderChat(
      request,
      (chunk) => {
        if (chunk.message?.content || chunk.message?.thinking) waitForProgress()
        content += chunk.message?.content ?? ''
        thinking += chunk.message?.thinking ?? ''
        if (chunk.prompt_eval_count !== undefined) promptTokens = chunk.prompt_eval_count
        if (chunk.eval_count !== undefined) completionTokens = chunk.eval_count
        if (chunk.done_reason) finishReason = chunk.done_reason
      },
      signal ? AbortSignal.any([signal, idle.signal]) : idle.signal
    )
    if (timedOut && !signal?.aborted) {
      return {
        ok: false,
        error: `The model made no progress on the summary for ${Math.round(idleTimeoutMs / 60_000)} minutes, so SideKick stopped waiting.`
      }
    }
    if (!result.ok) return { ok: false, error: result.error, status: result.status }
    return {
      ok: true,
      data: {
        message: { role: 'assistant', content: content.trim(), ...(thinking ? { thinking } : {}) },
        promptTokens,
        completionTokens,
        reasoningTokens: 0,
        finishReason
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Why the model's summary could not be used, in terms that hold no content. */
function fallbackReason(
  result: ProviderCompletionResult,
  truncated: boolean
): { reason: CompactionFallbackReason; status?: number } {
  if (!result.ok) {
    const error = result.error || ''
    const status = result.status
    const connection = providerConnectionFailureKind(error)
    const reason: CompactionFallbackReason =
      connection === 'timed-out' || status === 408 || status === 504
        ? 'timeout'
        : connection === 'dropped'
          ? 'connection_lost'
          : connection === 'unreachable'
            ? 'server_unreachable'
            : providerContextWindowError(error)
              ? 'context_overflow'
              : 'provider_error'
    return status ? { reason, status } : { reason }
  }
  if (truncated) return { reason: 'output_limit' }
  return { reason: result.data?.message.thinking?.trim() ? 'reasoning_only' : 'empty_output' }
}

function chooseSplit(messages: ProviderChatMessage[], contextLength: number): number {
  // The recent work stays word for word. Keeping only a few thousand tokens of it made the agent
  // re-read what it had just seen, so a large window filled again soon after each summary.
  const targetRecentTokens = Math.min(32_000, Math.max(2_000, Math.floor(contextLength * 0.2)))
  let retainedTokens = 0
  let split = messages.length
  for (let index = messages.length - 1; index >= 0; index--) {
    const tokens = estimateConversationTokens([messages[index]])
    if (retainedTokens > 0 && retainedTokens + tokens > targetRecentTokens) break
    retainedTokens += tokens
    split = index
  }
  while (split > 0 && messages[split]?.role === 'tool') split--
  // A long-running agent turn naturally has its latest user request near the
  // beginning, followed by many complete assistant/tool exchanges. The request
  // is preserved by the compaction summary; forcing it into the verbatim tail
  // would make the compactable prefix empty. If schemas alone trigger the
  // budget while the whole transcript fits in the preferred tail, compact the
  // complete validated transcript instead of failing with a false boundary
  // error.
  if (split === 0 && messages.length) split = messages.length
  return split
}

export class AgentContextManager implements AgentKernelContextManager {
  private compactionCount = 0
  private compactionsSinceSuccessfulSample = 0
  private previousSummary: string | null
  private estimationBiasTokens = 0

  constructor(private options: AgentContextManagerOptions) {
    this.previousSummary = options.previousSummary ?? null
    this.estimationBiasTokens = Math.round(options.initialEstimationBiasTokens ?? 0) || 0
  }

  /**
   * Adopt a window the provider reported about itself. A configured length can
   * be wrong — a profile swapped on the server, a value typed by hand — and
   * budgeting against a window larger than the real one means compaction never
   * frees enough, so the retry fails again on the same limit.
   */
  applyContextLength(contextLength: number, maxOutputTokens: number): void {
    this.options = { ...this.options, contextLength, maxOutputTokens }
  }

  get contextLength(): number {
    return this.options.contextLength
  }

  shouldCompact(messages: ProviderChatMessage[], tools: readonly unknown[]): boolean {
    if (
      !this.options.enabled ||
      this.compactionsSinceSuccessfulSample >= MAX_CONSECUTIVE_COMPACTIONS_WITHOUT_SAMPLE
    ) {
      return false
    }
    return calculateRequestBudget({
      messages,
      tools,
      contextLength: this.options.contextLength,
      reservedOutputTokens: this.options.maxOutputTokens,
      compactionThreshold: this.options.threshold,
      estimationBiasTokens: this.estimationBiasTokens
    }).shouldCompact
  }

  replyLimit(
    messages: ProviderChatMessage[],
    tools: readonly unknown[],
    maxOutputTokens: number | undefined
  ): number | undefined {
    return replyLimitForRequest(
      maxOutputTokens,
      calculateRequestBudget({
        messages,
        tools,
        contextLength: this.options.contextLength,
        reservedOutputTokens: this.options.maxOutputTokens,
        compactionThreshold: this.options.threshold,
        estimationBiasTokens: this.estimationBiasTokens
      })
    )
  }

  /**
   * Learns from the provider's real count for the request just sent, in either direction: the next
   * request is then budgeted as that real count plus the estimate of what was added since. Returns
   * the estimate it compared against, for the journal.
   */
  observeUsage(
    messages: ProviderChatMessage[],
    tools: readonly unknown[],
    promptTokens: number
  ): number | undefined {
    this.compactionsSinceSuccessfulSample = 0
    if (!Number.isFinite(promptTokens) || promptTokens <= 0) return undefined
    const estimated = estimateProviderRequestTokens(messages, tools)
    this.estimationBiasTokens = Math.ceil(promptTokens) - estimated
    return estimated
  }

  async compact(
    messages: ProviderChatMessage[],
    _tools: readonly unknown[],
    signal: AbortSignal
  ): Promise<{
    messages: ProviderChatMessage[]
    compacted: boolean
    details?: Record<string, unknown>
  }> {
    if (this.compactionsSinceSuccessfulSample >= MAX_CONSECUTIVE_COMPACTIONS_WITHOUT_SAMPLE) {
      return {
        messages,
        compacted: false,
        details: {
          reason: 'consecutive_compaction_limit_reached',
          count: this.compactionCount,
          consecutiveCount: this.compactionsSinceSuccessfulSample
        }
      }
    }
    const system = messages.filter((message) => message.role === 'system')
    // The project's instructions hold for the whole run and stay word for word. Summarized with
    // the history, they were left as a paraphrase until the next run loaded them again.
    const projectInstructions = messages.filter(isProjectInstructionsMessage)
    const conversation = messages.filter(
      (message) => message.role !== 'system' && !isProjectInstructionsMessage(message)
    )
    const split = chooseSplit(conversation, this.options.contextLength)
    const compactedMessages = conversation.slice(0, split)
    const recent = conversation.slice(split)
    if (!compactedMessages.length) {
      return {
        messages: [...system, ...projectInstructions, ...recent],
        compacted: false,
        details: { reason: 'no_compactable_conversation' }
      }
    }
    const previous = this.previousSummary || previousSummaryFrom(compactedMessages)
    const originalTokens = estimateConversationTokens(compactedMessages)
    const completion = this.options.complete ?? streamSummaryCompletion
    // A reasoning model thinks before it writes the summary; with too little room it ran out and
    // the summary fell back to the deterministic one.
    const summaryOutputTokens = Math.max(1_024, Math.min(16_384, this.options.maxOutputTokens))
    const instructions = getSummarizationPrompt(Boolean(this.options.focusChainEnabled))
    // The request has to fit the window with the summary's room: the instructions, the previous
    // summary and a margin come off before the history gets its share.
    const fixedTokens = estimateProviderRequestTokens(
      [
        { role: 'system', content: instructions },
        { role: 'user', content: summaryRequestUserContent(previous, '') }
      ],
      []
    )
    const summaryInputTokens = Math.max(
      2_000,
      this.options.contextLength -
        summaryOutputTokens -
        fixedTokens -
        Math.max(256, Math.floor(this.options.contextLength * 0.02))
    )
    const summaryInput = serializeMessages(compactedMessages, summaryInputTokens)
    const result = await completion(
      {
        target: this.options.target,
        purpose: 'compaction',
        maxOutputTokens: summaryOutputTokens,
        temperature: 0.1,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: summaryRequestUserContent(previous, summaryInput.text) }
        ]
      },
      signal
    )
    // A summary the run was stopped in the middle of is not a compaction. Recording the
    // deterministic stand-in as one kept it, so a later run started from the lossy excerpts.
    signal.throwIfAborted()
    // A partial handoff must not silently replace durable context as if complete.
    const truncated =
      result.ok && ['length', 'max_tokens'].includes(result.data?.finishReason || '')
    let summary = result.ok && !truncated ? result.data?.message.content.trim() : ''
    let strategy: 'model' | 'deterministic' = 'model'
    const fallback = summary ? undefined : fallbackReason(result, truncated)
    if (!summary) {
      strategy = 'deterministic'
      summary = deterministicSummary(previous, compactedMessages)
    }
    if (summaryInput.truncated)
      summary +=
        '\n\nHistorical input contained omitted excerpts. This handoff is not complete evidence; consult the durable transcript and current files for missing details before consequential actions.'
    const summaryTokens = Math.max(1, Math.ceil(summary.length / 4))
    if (summaryTokens >= originalTokens) {
      throw new Error(
        'Compaction did not reduce context; start a new task or use a larger model context'
      )
    }
    this.previousSummary = summary
    this.compactionCount++
    this.compactionsSinceSuccessfulSample++
    this.estimationBiasTokens = 0
    const record: AgentCompactionRecord = {
      summary,
      originalTokens,
      summaryTokens,
      messagesCompacted: compactedMessages.length,
      strategy,
      promptVersion: COMPACTION_PROMPT_VERSION,
      provider: this.options.target.providerKind,
      model: this.options.target.model,
      inputTruncated: summaryInput.truncated,
      ...(fallback ? { fallbackReason: fallback.reason } : {}),
      compactedMessages
    }
    this.options.onCompacted?.(record)
    // The request the run is answering stays word for word. Left to the summary, a local model
    // wrote an earlier question in as the objective, and the agent answered that one instead.
    const requestIndex = latestRequestIndex(conversation)
    const request = requestIndex >= 0 && requestIndex < split ? [conversation[requestIndex]] : []
    return {
      messages: [
        ...system,
        ...projectInstructions,
        compactionMessage(summary),
        ...request,
        ...recent
      ],
      compacted: true,
      details: {
        summary,
        strategy,
        promptVersion: COMPACTION_PROMPT_VERSION,
        provider: this.options.target.providerKind,
        model: this.options.target.model,
        originalTokens,
        summaryTokens,
        messagesCompacted: compactedMessages.length,
        inputTruncated: summaryInput.truncated,
        summaryInputTokens: estimateTextTokens(summaryInput.text),
        summaryReplyLimit: summaryOutputTokens,
        ...(fallback
          ? {
              fallbackReason: fallback.reason,
              ...(fallback.status ? { fallbackStatus: fallback.status } : {})
            }
          : {}),
        ...(result.ok && result.data?.promptTokens
          ? { summaryPromptTokens: result.data.promptTokens }
          : {}),
        count: this.compactionCount
      }
    }
  }
}
