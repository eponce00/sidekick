export const MIN_AGENT_WAIT_SECONDS = 1
/** The longest plain wait: one with nothing to wake it early only guesses how long work takes. */
export const MAX_AGENT_WAIT_SECONDS = 200
/** The longest wait for a command or its output, which ends the moment that happens. */
export const MAX_AGENT_CONDITIONAL_WAIT_SECONDS = 1_800

export interface AgentWaitResult<Event = never> {
  /** Ran its full duration; false when cancelled or woken. */
  completed: boolean
  requestedSeconds: number
  waitedMs: number
  reason?: 'cancelled' | 'woken'
  /** What woke the wait early. */
  event?: Event
}

export interface AgentWaitOptions<Event> {
  signal?: AbortSignal
  maxSeconds?: number
  /** Subscribes to whatever may end the wait early; returns how to unsubscribe. */
  wake?: (wake: (event: Event) => void) => () => void
}

export function normalizeAgentWaitSeconds(
  value: unknown,
  maxSeconds = MAX_AGENT_WAIT_SECONDS
): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return MIN_AGENT_WAIT_SECONDS
  return Math.max(MIN_AGENT_WAIT_SECONDS, Math.min(maxSeconds, Math.round(numeric)))
}

/**
 * A bounded, host-shell-independent wait that ends on run cancellation, or as soon as something
 * it watches happens: the agent says how long it will wait at most, not how long the work takes.
 */
export function waitForAgentDelay<Event = never>(
  requestedSeconds: unknown,
  options: AgentWaitOptions<Event> = {}
): Promise<AgentWaitResult<Event>> {
  const seconds = normalizeAgentWaitSeconds(requestedSeconds, options.maxSeconds)
  const durationMs = seconds * 1_000
  const startedAt = Date.now()

  return new Promise((resolve) => {
    let settled = false
    const handles: { timer?: ReturnType<typeof setTimeout>; unsubscribe?: () => void } = {}

    const finish = (
      result: Pick<AgentWaitResult<Event>, 'completed' | 'reason' | 'event'>
    ): void => {
      if (settled) return
      settled = true
      if (handles.timer) clearTimeout(handles.timer)
      handles.unsubscribe?.()
      options.signal?.removeEventListener('abort', onAbort)
      resolve({
        ...result,
        requestedSeconds: seconds,
        waitedMs: Math.min(durationMs, Math.max(0, Date.now() - startedAt))
      })
    }
    const onAbort = (): void => finish({ completed: false, reason: 'cancelled' })

    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    handles.timer = setTimeout(() => finish({ completed: true }), durationMs)
    handles.unsubscribe = options.wake?.((event) =>
      finish({ completed: false, reason: 'woken', event })
    )
    // A subscription can report at once, before it could be unsubscribed.
    if (settled) handles.unsubscribe?.()
  })
}

/** A wait's row in the chat: what it waits for, or only for how long. */
export function agentWaitTitle(args: Record<string, unknown>): string {
  const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''
  if (pattern) return `Wait for “${pattern.length > 40 ? `${pattern.slice(0, 39)}…` : pattern}”`
  const ids = Array.isArray(args.taskIds) ? args.taskIds.length : args.taskId ? 1 : 0
  if (ids) return ids === 1 ? 'Wait for the command' : `Wait for ${ids} commands`
  const seconds = Number(args.seconds)
  return Number.isFinite(seconds) && seconds > 0 ? `Wait ${Math.round(seconds)}s` : 'Wait'
}
