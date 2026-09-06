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
    const timeout = input.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          timeoutController.abort(new ToolRuntimeTimeoutError(input.timeoutMs!))
        }, input.timeoutMs)
      : undefined
    timeout?.unref()
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
      return await Promise.race([lifecycle(), aborted])
    } finally {
      if (timeout) clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
  }
}
