import type { ToolExecutionError, ToolExecutionResult } from '../../shared/agentRuntime'
import {
  ProviderSetupError,
  providerConnectionFailureKind,
  providerImageLimitError,
  providerQuotaExhausted,
  redactProviderCredentials
} from '../../shared/providerErrors'

export class AgentToolLoopError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentToolLoopError'
  }
}

/** A model request the provider refused or could not serve, with its HTTP status when it had one. */
export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The provider's own name for the error, such as `insufficient_quota`. */
    readonly code?: string
  ) {
    super(message)
    this.name = 'ProviderRequestError'
  }
}

type ProviderFailure = Pick<ToolExecutionError, 'code' | 'message' | 'retryable' | 'recoveryAction'>

const STATUS_TEXT: Record<number, string> = {
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout'
}

/**
 * Says what an HTTP refusal means for the reply and what to do about it, keeping the provider's
 * own words, which are often the most specific part, after SideKick's.
 */
function providerRefusal(error: ProviderRequestError): ProviderFailure | null {
  const { status } = error
  if (!status || status < 400) return null
  const detail = redactProviderCredentials(error.message).trim()
  const said = !detail || detail === `HTTP ${status}` ? '' : ` The provider said: ${detail}`
  const http = `HTTP ${status}${STATUS_TEXT[status] ? ` ${STATUS_TEXT[status]}` : ''}`
  const refused = (code: ToolExecutionError['code'], message: string): ProviderFailure => ({
    code,
    message: `${message}${said}`,
    retryable: true,
    recoveryAction: 'correct_input'
  })
  const unavailable = (code: ToolExecutionError['code'], message: string): ProviderFailure => ({
    code,
    message: `${message}${said}`,
    retryable: true,
    recoveryAction: 'retry_later'
  })
  if (status === 401 || status === 403)
    return refused(
      'permission_denied',
      `The provider refused SideKick's credentials (${http}). Check the API key in Settings → Providers.`
    )
  if (status === 404)
    return refused(
      'not_found',
      `The provider has no such model or address (${http}). Check the model and the server address in Settings → Providers.`
    )
  if (status === 408)
    return unavailable('timeout', `The model server gave up waiting for the request (${http}).`)
  if (status === 429 && providerQuotaExhausted({ error: error.message, code: error.code }))
    return refused(
      'permission_denied',
      `The provider account has run out of quota or credit (${http}). Check its plan and billing, or choose another model.`
    )
  if (status === 429)
    return unavailable(
      'transient',
      `The provider is limiting how often SideKick may send requests (${http}). Wait a moment before continuing.`
    )
  if (status === 502 || status === 504)
    return unavailable(
      'transient',
      `The server in front of the model got no answer from it (${http}). Check that the model server behind it is running.`
    )
  if (status === 503)
    return unavailable('transient', `The model server is not taking requests right now (${http}).`)
  if (status >= 500)
    return unavailable('transient', `The model server failed while handling the request (${http}).`)
  return refused('invalid_arguments', `The provider refused the request (${http}).`)
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
    : error instanceof ProviderRequestError
      ? redactProviderCredentials(error.message)
      : error instanceof Error
        ? error.message
        : String(error)
  const imageLimit = cancelled ? null : providerImageLimitError(message)
  const connection = cancelled ? null : providerConnectionFailureKind(message)
  const provider: ProviderFailure | null =
    cancelled || loopDetected || imageLimit || connection
      ? null
      : error instanceof ProviderSetupError
        ? {
            code: 'not_configured',
            message: `${message}. Choose another model for this chat, or set this one up in Settings → Providers.`,
            retryable: true,
            recoveryAction: 'correct_input'
          }
        : error instanceof ProviderRequestError
          ? providerRefusal(error)
          : null
  const displayMessage = imageLimit
    ? `The model accepts at most ${imageLimit.maxImages ?? 'a limited number of'} images per request. SideKick could not send this turn.`
    : (provider?.message ?? message)
  const failure: ToolExecutionError = {
    code: cancelled
      ? 'cancelled'
      : loopDetected
        ? 'loop_detected'
        : imageLimit
          ? 'invalid_arguments'
          : connection === 'timed-out'
            ? 'timeout'
            : connection
              ? 'transient'
              : (provider?.code ?? 'internal'),
    message: displayMessage,
    retryable: provider?.retryable ?? (!cancelled && !loopDetected && !imageLimit),
    recoveryAction:
      provider?.recoveryAction ??
      (cancelled || loopDetected || imageLimit ? 'stop' : 'retry_later'),
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
