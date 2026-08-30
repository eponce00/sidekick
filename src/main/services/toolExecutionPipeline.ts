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
    input.onStage?.('preparing')
    for (const hook of this.beforeHooks) await hook(context)
    input.onStage?.('guarding')
    for (const guard of this.guards) {
      const denial = guard({ name: input.name, arguments: frozenArguments })
      if (denial) throw new Error(`Tool execution denied: ${denial}`)
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
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener(
        'abort',
        () =>
          reject(
            timedOut
              ? new ToolRuntimeTimeoutError(input.timeoutMs!)
              : new DOMException('Tool execution cancelled', 'AbortError')
          ),
        { once: true }
      )
    })
    try {
      const executionContext = { ...context, signal }
      let dispatch = (): Promise<T> => input.body(signal)
      for (const hook of [...this.aroundHooks].reverse()) {
        const next = dispatch
        dispatch = () => hook(executionContext, next)
      }
      input.onStage?.('executing')
      let result = (await Promise.race([dispatch(), aborted])) as T
      input.onStage?.('finalizing')
      for (const hook of this.afterHooks) {
        result = (await hook(executionContext, result)) as T
      }
      input.onStage?.('completed')
      return result
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}
