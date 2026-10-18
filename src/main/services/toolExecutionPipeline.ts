import { AsyncLocalStorage } from 'node:async_hooks'

export class ToolRuntimeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Tool execution timed out after ${timeoutMs} ms`)
    this.name = 'ToolRuntimeTimeoutError'
  }
}

export interface ToolExecutionGuardInput {
  name: string
  arguments: Readonly<Record<string, unknown>>
}

export type ToolExecutionGuard = (input: ToolExecutionGuardInput) => string | undefined

export type ToolExecutionStage = 'preparing' | 'guarding' | 'executing' | 'finalizing' | 'completed'

export interface ToolExecutionContext extends ToolExecutionGuardInput {
  signal: AbortSignal
}

export type ToolExecutionBeforeHook = (input: ToolExecutionContext) => void | Promise<void>
export type ToolExecutionAroundHook = <T>(
  input: ToolExecutionContext,
  next: () => Promise<T>
) => Promise<T>
export type ToolExecutionAfterHook<T = unknown> = (
  input: ToolExecutionContext,
  result: T
) => T | Promise<T>

interface ToolClock {
  /** Stops the tool's time limit; the returned function starts it again. */
  pause: () => () => void
}

const runningToolClock = new AsyncLocalStorage<ToolClock>()

/**
 * Waits for the user without spending the running tool's time limit: a person answering a
 * question is not the tool being slow. Outside a tool call it simply waits.
 */
export async function whileWaitingForUser<T>(wait: () => Promise<T>): Promise<T> {
  const resume = runningToolClock.getStore()?.pause()
  try {
    return await wait()
  } finally {
    resume?.()
  }
}

/** A time limit that can be stopped and started again, keeping what was left of it. */
function pausableTimeout(
  milliseconds: number,
  onTimeout: () => void
): ToolClock & { clear: () => void } {
  let remaining = milliseconds
  let startedAt = Date.now()
  let pauses = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const start = (): void => {
    startedAt = Date.now()
    timer = setTimeout(onTimeout, remaining)
    timer.unref?.()
  }
  start()
  return {
    pause: () => {
      if (pauses++ === 0 && timer) {
        clearTimeout(timer)
        timer = undefined
        remaining = Math.max(0, remaining - (Date.now() - startedAt))
      }
      let resumed = false
      return () => {
        if (resumed) return
        resumed = true
        if (--pauses === 0) start()
      }
    },
    clear: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      pauses = Number.POSITIVE_INFINITY
    }
  }
}

/**
 * Canonical execution boundary shared by every model-facing tool.
 * Guards are monotonic: they may deny but can never widen an earlier decision.
 */
export class ToolExecutionPipeline {
  private readonly guards: ToolExecutionGuard[] = []
  private readonly beforeHooks: ToolExecutionBeforeHook[] = []
  private readonly aroundHooks: ToolExecutionAroundHook[] = []
  private readonly afterHooks: ToolExecutionAfterHook<unknown>[] = []

  private register<T>(collection: T[], value: T): () => void {
    collection.push(value)
    return () => {
      const index = collection.indexOf(value)
      if (index >= 0) collection.splice(index, 1)
    }
  }

  registerGuard(guard: ToolExecutionGuard): () => void {
    return this.register(this.guards, guard)
  }

  registerBefore(hook: ToolExecutionBeforeHook): () => void {
    return this.register(this.beforeHooks, hook)
  }

  registerAround(hook: ToolExecutionAroundHook): () => void {
    return this.register(this.aroundHooks, hook)
  }

  registerAfter<T>(hook: ToolExecutionAfterHook<T>): () => void {
    return this.register(this.afterHooks, hook as unknown as ToolExecutionAfterHook<unknown>)
  }

  async execute<T>(input: {
    name: string
    arguments: Record<string, unknown>
    signal: AbortSignal
    timeoutMs?: number
    body: (signal: AbortSignal) => Promise<T>
    onStage?: (stage: ToolExecutionStage) => void
  }): Promise<T> {
    const frozenArguments = Object.freeze(structuredClone(input.arguments))
    const context: ToolExecutionContext = {
      name: input.name,
      arguments: frozenArguments,
      signal: input.signal
    }
    if (input.signal.aborted) throw new DOMException('Tool execution cancelled', 'AbortError')
    const timeoutController = new AbortController()
    let timedOut = false
    // The limit stops while the tool waits for the user, as for an approval dialog.
    const timeout = input.timeoutMs
      ? pausableTimeout(input.timeoutMs, () => {
          timedOut = true
          timeoutController.abort(new ToolRuntimeTimeoutError(input.timeoutMs!))
        })
      : undefined
    const signal = AbortSignal.any([input.signal, timeoutController.signal])
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () =>
        reject(
          timedOut
            ? new ToolRuntimeTimeoutError(input.timeoutMs!)
            : new DOMException('Tool execution cancelled', 'AbortError')
        )
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const executionContext = { ...context, signal }
      const checkCancelled = (): void => {
        if (signal.aborted) throw signal.reason
      }
      const lifecycle = async (): Promise<T> => {
        input.onStage?.('preparing')
        for (const hook of this.beforeHooks) {
          checkCancelled()
          await hook(executionContext)
        }
        checkCancelled()
        input.onStage?.('guarding')
        for (const guard of this.guards) {
          const denial = guard({ name: input.name, arguments: frozenArguments })
          if (denial) throw new Error(`Tool execution denied: ${denial}`)
        }
        let dispatched = false
        let dispatch = (): Promise<T> => {
          checkCancelled()
          if (dispatched) throw new Error('Tool executor may only be invoked once')
          dispatched = true
          return input.body(signal)
        }
        for (const hook of [...this.aroundHooks].reverse()) {
          const next = dispatch
          dispatch = () => hook(executionContext, next)
        }
        input.onStage?.('executing')
        let result: T = await dispatch()
        checkCancelled()
        input.onStage?.('finalizing')
        for (const hook of this.afterHooks) {
          checkCancelled()
          result = (await hook(executionContext, result)) as T
        }
        checkCancelled()
        input.onStage?.('completed')
        return result
      }
      const run = (): Promise<T> => Promise.race([lifecycle(), aborted])
      return await (timeout ? runningToolClock.run(timeout, run) : run())
    } finally {
      timeout?.clear()
      signal.removeEventListener('abort', onAbort)
    }
  }
}
