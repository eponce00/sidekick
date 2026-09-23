import type { ToolExecutionError, ToolExecutionResult } from '../../shared/agentRuntime'
import { providerImageLimitError } from '../../shared/providerErrors'

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
  const imageLimit = cancelled ? null : providerImageLimitError(message)
  const displayMessage = imageLimit
    ? `The model accepts at most ${imageLimit.maxImages ?? 'a limited number of'} images per request. SideKick could not send this turn.`
    : message
  const failure: ToolExecutionError = {
    code: cancelled
      ? 'cancelled'
      : loopDetected
        ? 'loop_detected'
        : imageLimit
          ? 'invalid_arguments'
          : 'internal',
    message: displayMessage,
    retryable: !cancelled && !loopDetected && !imageLimit,
    recoveryAction: cancelled || loopDetected || imageLimit ? 'stop' : 'retry_later',
    ...(imageLimit
      ? {
          // The provider's own words are the only way to tell an unfamiliar
          // gateway's limit apart from a model that takes no images at all.
          recovery: `Reduce the number of attached images, or turn off Vision for this model in Settings → Providers if it cannot accept any. The provider said: ${message}`
        }
      : loopDetected
        ? {
            recovery:
              'The run stopped because its tool calls were no longer making progress. Change the approach or provide new information before starting again.'
          }
        : {})
  }
  return {
    phase: cancelled ? ('cancelled' as const) : ('failed' as const),
    message: displayMessage,
    error: failure
  }
}
