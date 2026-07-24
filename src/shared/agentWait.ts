export const MIN_AGENT_WAIT_SECONDS = 1
export const MAX_AGENT_WAIT_SECONDS = 200

export interface AgentWaitResult {
  completed: boolean
  requestedSeconds: number
  waitedMs: number
  reason?: 'cancelled'
}

export interface AgentWaitOptions {
  signal?: AbortSignal
  isCancelled?: () => boolean
  pollIntervalMs?: number
}

export function normalizeAgentWaitSeconds(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return MIN_AGENT_WAIT_SECONDS
  return Math.max(MIN_AGENT_WAIT_SECONDS, Math.min(MAX_AGENT_WAIT_SECONDS, Math.round(numeric)))
}

/** A bounded, host-shell-independent delay that responds promptly to run cancellation. */
export function waitForAgentDelay(
  requestedSeconds: unknown,
  options: AgentWaitOptions = {}
): Promise<AgentWaitResult> {
  const seconds = normalizeAgentWaitSeconds(requestedSeconds)
  const durationMs = seconds * 1_000
  const startedAt = Date.now()

  return new Promise((resolve) => {
    let settled = false
    const timers: {
      completion?: ReturnType<typeof setTimeout>
      cancellation?: ReturnType<typeof setInterval>
    } = {}

    const finish = (completed: boolean): void => {
      if (settled) return
      settled = true
      if (timers.completion) clearTimeout(timers.completion)
      if (timers.cancellation) clearInterval(timers.cancellation)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({
        completed,
        requestedSeconds: seconds,
        waitedMs: Math.min(durationMs, Math.max(0, Date.now() - startedAt)),
        ...(completed ? {} : { reason: 'cancelled' as const })
      })
    }
    const onAbort = (): void => finish(false)

    if (options.signal?.aborted || options.isCancelled?.()) {
      finish(false)
      return
    }

    options.signal?.addEventListener('abort', onAbort, { once: true })
    timers.completion = setTimeout(() => finish(true), durationMs)
    if (options.isCancelled) {
      const pollIntervalMs = Math.max(25, Math.min(1_000, options.pollIntervalMs ?? 100))
      timers.cancellation = setInterval(() => {
        if (options.isCancelled?.()) finish(false)
      }, pollIntervalMs)
    }
  })
}
