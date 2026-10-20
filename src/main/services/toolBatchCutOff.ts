import type { ProviderToolCall } from '../../shared/providerRuntime'

/** Providers' spellings for a reply the output limit stopped. */
export function isOutputLimitStop(doneReason: string): boolean {
  const normalized = doneReason.trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')
  return (
    normalized === 'length' ||
    normalized === 'max_tokens' ||
    normalized === 'max_output_tokens' ||
    normalized === 'token_limit' ||
    normalized === 'model_length'
  )
}

/** How SideKick knew a reply was cut: the provider said so, or the reply used its allowance. */
export type CutOffTrigger = 'stop_reason' | 'used_allowance'

/** A reply the output limit cut off while it wrote tool calls, as the run journal records it. */
export interface ToolBatchCutOff {
  trigger: CutOffTrigger
  doneReason: string
  completionTokens: number
  /** The reply limit the request asked for. */
  replyLimit?: number
  /** The model's own reply limit, before it was cut to the room the window had left. */
  maxOutputTokens?: number
  toolCallCount: number
}

/** Whether the reply limit was the model's own or one cut to the room left in the window. */
export function cutOffLimit(
  cutOff: Pick<ToolBatchCutOff, 'replyLimit' | 'maxOutputTokens'>
): 'shrunk' | 'full' | 'unrecorded' {
  if (!cutOff.replyLimit || !cutOff.maxOutputTokens) return 'unrecorded'
  return cutOff.replyLimit < cutOff.maxOutputTokens ? 'shrunk' : 'full'
}

/**
 * How the tokens the server reported compare with the limit asked for. Over it, the server
 * counted something the limit does not cover, such as reasoning, or did not apply the limit.
 * Well under it, a stop for length came from a lower cap of the server's own.
 */
export function cutOffUsage(
  cutOff: Pick<ToolBatchCutOff, 'replyLimit' | 'completionTokens'>
): 'at_limit' | 'over_limit' | 'under_limit' | 'unrecorded' {
  if (!cutOff.replyLimit || !cutOff.completionTokens) return 'unrecorded'
  if (cutOff.completionTokens > cutOff.replyLimit) return 'over_limit'
  return cutOff.completionTokens >= cutOff.replyLimit * 0.95 ? 'at_limit' : 'under_limit'
}

/**
 * The most tool calls one reply may write. Batches of reads run to a few dozen; a reply past this
 * is not planning. One model wrote 784 calls in one reply, for five minutes, until its output limit
 * cut it off.
 */
export const MAX_TOOL_CALLS_PER_REPLY = 64
/**
 * The most times one reply may repeat a call, same tool and same arguments. 781 of those 784
 * calls were one `browser_click`. OpenCode asks the user at the third identical call in a row,
 * and Gemini CLI stops the stream at the fifth; within a single reply, a fourth copy of a call is
 * never new work.
 */
export const MAX_IDENTICAL_TOOL_CALLS = 3

/** Why a reply was stopped while it wrote tool calls. */
export interface ToolCallRunaway {
  kind: 'too_many_calls' | 'repeated_call'
  /** Calls the reply had begun when it was stopped. */
  toolCallCount: number
  /** Copies of the call it repeated most. */
  identicalCalls: number
  /** That call's tool. */
  toolName: string
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
  )
}

/** A call's identity: its tool and its arguments, whatever their key order or spacing. */
export function toolCallSignature(name: string, args: unknown): string {
  let parsed = args
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args)
    } catch {
      parsed = args
    }
  }
  return `${name}\u0000${JSON.stringify(canonical(parsed ?? {}))}`
}

/**
 * Watches the tool calls a reply writes, while it streams and once it is whole, and says when it
 * has run away: more calls than any plan needs, or one call written over and over.
 */
export class ToolCallRunawayGuard {
  private readonly started = new Set<string>()
  private readonly closed = new Map<string, string>()
  private readonly copies = new Map<string, { count: number; name: string }>()

  constructor(
    private readonly maxCalls = MAX_TOOL_CALLS_PER_REPLY,
    private readonly maxIdentical = MAX_IDENTICAL_TOOL_CALLS
  ) {}

  /** A call the reply has begun, known by its id or index. */
  begin(key: string): ToolCallRunaway | undefined {
    this.started.add(key)
    return this.check()
  }

  /** A call the reply has finished writing, with its whole arguments. */
  close(key: string, name: string, args: unknown): ToolCallRunaway | undefined {
    this.started.add(key)
    if (!this.closed.has(key)) {
      const signature = toolCallSignature(name, args)
      this.closed.set(key, signature)
      const entry = this.copies.get(signature) ?? { count: 0, name }
      entry.count += 1
      this.copies.set(signature, entry)
    }
    return this.check()
  }

  /** The finished reply's calls, for replies that arrive whole rather than streamed. */
  closeAll(calls: readonly ProviderToolCall[]): ToolCallRunaway | undefined {
    let found: ToolCallRunaway | undefined
    calls.forEach((call, index) => {
      found =
        this.close(
          call.id || `tool_index_${call.index ?? index}`,
          call.function.name,
          call.function.arguments
        ) ?? found
    })
    return found
  }

  /** The calls seen so far, and the call repeated most. */
  get stats(): { toolCallCount: number; identicalCalls: number; toolName: string } {
    const most = [...this.copies.values()].reduce<{ count: number; name: string }>(
      (best, entry) => (entry.count > best.count ? entry : best),
      { count: 0, name: '' }
    )
    return { toolCallCount: this.started.size, identicalCalls: most.count, toolName: most.name }
  }

  private check(): ToolCallRunaway | undefined {
    const stats = this.stats
    if (stats.identicalCalls > this.maxIdentical) return { kind: 'repeated_call', ...stats }
    if (stats.toolCallCount > this.maxCalls) return { kind: 'too_many_calls', ...stats }
    return undefined
  }
}

/** Replies cut off while they wrote tool calls, counted by reply. Numbers only. */
export interface CutOffTurnSummary {
  /** Replies the output limit cut off while they wrote tool calls. */
  turns: number
  /** Calls refused with them, since a cut reply's calls may be incomplete. */
  refusedCalls: number
  /** Replies with more than one call. */
  multiCallTurns: number
  /** Cut replies that came right after another in the same run: a retry cut the same way. */
  repeatedTurns: number
  byTrigger: Record<CutOffTrigger, number>
  byLimit: Record<ReturnType<typeof cutOffLimit>, number>
  byUsage: Record<ReturnType<typeof cutOffUsage>, number>
}

/** Replies that wrote far more calls than a plan needs, or one call over and over. */
export interface RunawayTurnSummary {
  turns: number
  /** Of them, the replies SideKick stopped while they streamed. */
  stopped: number
  largestCallCount: number
  largestIdenticalCount: number
}

export function emptyCutOffSummary(): CutOffTurnSummary {
  return {
    turns: 0,
    refusedCalls: 0,
    multiCallTurns: 0,
    repeatedTurns: 0,
    byTrigger: { stop_reason: 0, used_allowance: 0 },
    byLimit: { shrunk: 0, full: 0, unrecorded: 0 },
    byUsage: { at_limit: 0, over_limit: 0, under_limit: 0, unrecorded: 0 }
  }
}

export function emptyRunawaySummary(): RunawayTurnSummary {
  return { turns: 0, stopped: 0, largestCallCount: 0, largestIdenticalCount: 0 }
}

function count(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

/**
 * Reads one run's journal, in event order, for replies cut off while they wrote tool calls and
 * for replies that ran away. Older runs recorded only a cut's stop reason and batch size, and no
 * runaway at all; a runaway is then found from the calls the reply recorded.
 */
export class ToolCallTurnCounter {
  readonly cutOff = emptyCutOffSummary()
  readonly runaway = emptyRunawaySummary()
  /** The runaway replies of the run being read. */
  runRunaway = emptyRunawaySummary()
  private previousTurnCut = false
  private currentTurnCut = false

  /** The events that follow belong to another run. */
  startRun(): void {
    this.previousTurnCut = false
    this.currentTurnCut = false
    this.runRunaway = emptyRunawaySummary()
  }

  /**
   * A model turn ended. `toolCalls` are the calls it recorded, and `stopped` is what a reply
   * SideKick stopped recorded about itself.
   */
  turn(toolCalls: unknown, stopped?: unknown): void {
    this.previousTurnCut = this.currentTurnCut
    this.currentTurnCut = false
    const recorded =
      stopped && typeof stopped === 'object' ? (stopped as Record<string, unknown>) : undefined
    let calls = count(recorded?.toolCallCount)
    let identical = count(recorded?.identicalCalls)
    if (!recorded && Array.isArray(toolCalls)) {
      const guard = new ToolCallRunawayGuard(Infinity, Infinity)
      toolCalls.forEach((call, index) => {
        const entry = call && typeof call === 'object' ? (call as Record<string, unknown>) : {}
        guard.close(String(index), String(entry.name ?? ''), entry.arguments)
      })
      calls = toolCalls.length
      identical = guard.stats.identicalCalls
    }
    if (!recorded && calls <= MAX_TOOL_CALLS_PER_REPLY && identical <= MAX_IDENTICAL_TOOL_CALLS)
      return
    for (const summary of [this.runaway, this.runRunaway]) {
      summary.turns += 1
      if (recorded) summary.stopped += 1
      summary.largestCallCount = Math.max(summary.largestCallCount, calls)
      summary.largestIdenticalCount = Math.max(summary.largestIdenticalCount, identical)
    }
  }

  /** A `run.retrying` event with the reason `truncated_tool_batch`. */
  cutTurn(payload: Record<string, unknown>): void {
    const summary = this.cutOff
    const calls = count(payload.toolCallCount)
    summary.turns += 1
    summary.refusedCalls += calls
    if (calls > 1) summary.multiCallTurns += 1
    if (this.previousTurnCut) summary.repeatedTurns += 1
    this.currentTurnCut = true
    const trigger: CutOffTrigger =
      payload.trigger === 'used_allowance' || payload.trigger === 'stop_reason'
        ? payload.trigger
        : isOutputLimitStop(String(payload.doneReason ?? ''))
          ? 'stop_reason'
          : 'used_allowance'
    summary.byTrigger[trigger] += 1
    const limits = {
      replyLimit: count(payload.replyLimit),
      maxOutputTokens: count(payload.maxOutputTokens),
      completionTokens: count(payload.completionTokens)
    }
    summary.byLimit[cutOffLimit(limits)] += 1
    summary.byUsage[cutOffUsage(limits)] += 1
  }
}
