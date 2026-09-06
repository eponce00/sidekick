import type { ToolExecutionError, ToolExecutionResult } from '../../shared/agentRuntime'

export class AgentToolLoopError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentToolLoopError'
  }
}

/** Add model-facing recovery guidance without changing observed tool outcome or side effects. */
export function withToolGuard(result: ToolExecutionResult, guard: string): ToolExecutionResult {
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

/** Pure terminal policy shared by the durable transition and caller-facing result. */
export function classifyAgentKernelFailure(error: unknown, aborted: boolean) {
  const cancelled = aborted || (error instanceof Error && error.name === 'AbortError')
  const loopDetected = error instanceof AgentToolLoopError
  const message = cancelled
    ? 'Agent run cancelled'
    : error instanceof Error
      ? error.message
      : String(error)
  const failure: ToolExecutionError = {
    code: cancelled ? 'cancelled' : loopDetected ? 'loop_detected' : 'internal',
    message,
    retryable: !cancelled && !loopDetected,
    recoveryAction: cancelled || loopDetected ? 'stop' : 'retry_later',
    ...(loopDetected
      ? {
          recovery:
            'The run stopped because its tool calls were no longer making progress. Change the approach or provide new information before starting again.'
        }
      : {})
  }
  return {
    phase: cancelled ? ('cancelled' as const) : ('failed' as const),
    message,
    error: failure
  }
}
