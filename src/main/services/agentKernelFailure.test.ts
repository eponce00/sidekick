import { describe, expect, it } from 'vitest'
import {
  AgentToolLoopError,
  classifyAgentKernelFailure,
  ProviderRequestError,
  withToolGuard
} from './agentKernelFailure'
import { toolExecutionFailed, toolExecutionSucceeded } from '../../shared/agentRuntime'
import { ProviderSetupError } from '../../shared/providerErrors'

describe('kernel terminal policy', () => {
  it('fails a reply the model server dropped as a connection problem that can continue', () => {
    const failure = classifyAgentKernelFailure(
      new Error(
        'Lost the connection to the model server at 127.0.0.1:4000 while it was replying; the server stopped or restarted. (UND_ERR_SOCKET)'
      ),
      false
    )
    expect(failure.error).toMatchObject({
      code: 'transient',
      retryable: true,
      recoveryAction: 'retry_later'
    })
    expect(classifyAgentKernelFailure(new Error('boom'), false).error.code).toBe('internal')
  })

  it('fails a model server that went silent as a timeout that can continue', () => {
    const failure = classifyAgentKernelFailure(
      new Error(
        'The model server at 127.0.0.1:4000 took the request but sent no reply for 5 minutes, so SideKick stopped waiting. Check that it is not stuck or busy with another request. (UND_ERR_HEADERS_TIMEOUT)'
      ),
      false
    )
    expect(failure.error).toMatchObject({
      code: 'timeout',
      retryable: true,
      recoveryAction: 'retry_later'
    })
  })

  it('says what an HTTP refusal means instead of failing as internal', () => {
    const classify = (status: number, message: string) =>
      classifyAgentKernelFailure(new ProviderRequestError(message, status), false).error

    // A gateway with nothing behind it answers with a bare status and no body.
    expect(classify(502, 'HTTP 502')).toEqual({
      code: 'transient',
      message:
        'The server in front of the model got no answer from it (HTTP 502 Bad Gateway). Check that the model server behind it is running.',
      retryable: true,
      recoveryAction: 'retry_later'
    })
    expect(
      classify(
        500,
        'litellm.InternalServerError: InternalServerError: OpenAIException - Connection error.'
      )
    ).toMatchObject({
      code: 'transient',
      message:
        'The model server failed while handling the request (HTTP 500 Internal Server Error). The provider said: litellm.InternalServerError: InternalServerError: OpenAIException - Connection error.'
    })
    expect(classify(429, 'Rate limit reached').code).toBe('transient')
    expect(classify(503, 'HTTP 503').message).toContain('not taking requests right now')
    expect(classify(404, 'model "gone" not found')).toMatchObject({
      code: 'not_found',
      recoveryAction: 'correct_input'
    })
    expect(classify(400, 'Invalid request: unknown field')).toMatchObject({
      code: 'invalid_arguments',
      message:
        'The provider refused the request (HTTP 400). The provider said: Invalid request: unknown field'
    })
  })

  it('reports a refused key as such, without repeating the key back', () => {
    const failure = classifyAgentKernelFailure(
      new ProviderRequestError(
        'Authentication Error, Invalid proxy server token passed. Received API Key = sk-...wxyz, Key Hash (Token) =0123456789abcdef',
        401
      ),
      false
    )
    expect(failure.error).toMatchObject({
      code: 'permission_denied',
      retryable: true,
      recoveryAction: 'correct_input'
    })
    expect(failure.message).toContain(
      "The provider refused SideKick's credentials (HTTP 401). Check the API key in Settings → Providers."
    )
    expect(failure.message).not.toContain('wxyz')
    expect(failure.message).not.toContain('0123456789abcdef')
    // Also when the refusal came inside a stream, without a status.
    expect(
      classifyAgentKernelFailure(new ProviderRequestError('Bad key. api_key=sk-live-123'), false)
        .message
    ).toBe('Bad key. api_key=[redacted]')
  })

  it('tells the user to pick or set up a model when the chat names one that is gone', () => {
    expect(
      classifyAgentKernelFailure(
        new ProviderSetupError('Provider LiteLLM is not configured'),
        false
      ).error
    ).toEqual({
      code: 'not_configured',
      message:
        'Provider LiteLLM is not configured. Choose another model for this chat, or set this one up in Settings → Providers.',
      retryable: true,
      recoveryAction: 'correct_input'
    })
  })

  it('keeps unexplained failures internal, whatever they call themselves', () => {
    // Only the kernel's own typed errors carry a status or a setup problem.
    const impostor = new Error('Provider LiteLLM is not configured')
    impostor.name = 'ProviderSetupError'
    for (const error of [
      impostor,
      new Error('HTTP 502'),
      new ProviderRequestError('Provider stream ended before completion')
    ])
      expect(classifyAgentKernelFailure(error, false).error.code).toBe('internal')
  })

  it('adds recovery guidance without rewriting tool results or mutating prior evidence', () => {
    const failure = toolExecutionFailed({
      title: 'Patch',
      code: 'stale_read',
      message: 'Changed',
      recovery: 'Read again.',
      retryable: true
    })
    const before = structuredClone(failure)
    const guarded = withToolGuard(failure, 'Change strategy')
    expect(failure).toEqual(before)
    expect(guarded.error).toEqual({
      ...failure.error,
      recovery:
        'Read again. SideKick detected repeated behavior; do not repeat the unchanged approach.'
    })
    expect(guarded.status).toBe(failure.status)
    expect(guarded.data).toBe(failure.data)
    expect(guarded.modelContent).toBe(`${failure.modelContent}\nChange strategy`)
    const success = toolExecutionSucceeded({ title: 'Read', data: { text: 'unchanged' } })
    expect(withToolGuard(success, 'Do not re-read')).toEqual({
      ...success,
      modelContent: `${success.modelContent}\nDo not re-read`
    })
  })
  it('retains internal errors as retryable without inventing a successful final response', () => {
    expect(classifyAgentKernelFailure(new Error('provider failed'), false)).toEqual({
      phase: 'failed',
      message: 'provider failed',
      error: {
        code: 'internal',
        message: 'provider failed',
        retryable: true,
        recoveryAction: 'retry_later'
      }
    })
    expect(classifyAgentKernelFailure('non-Error rejection', false).message).toBe(
      'non-Error rejection'
    )
  })

  it('classifies provider image limits as non-retryable input errors', () => {
    expect(
      classifyAgentKernelFailure(
        new Error('At most 2 image(s) may be provided in one prompt.'),
        false
      )
    ).toMatchObject({
      phase: 'failed',
      message: 'The model accepts at most 2 images per request. SideKick could not send this turn.',
      error: {
        code: 'invalid_arguments',
        retryable: false,
        recoveryAction: 'stop'
      }
    })
  })

  it('keeps no-progress failures terminal and preserves their recovery contract', () => {
    expect(
      classifyAgentKernelFailure(new AgentToolLoopError('unchanged approach'), false)
    ).toMatchObject({
      phase: 'failed',
      error: {
        code: 'loop_detected',
        retryable: false,
        recoveryAction: 'stop',
        recovery: expect.stringContaining('Change the approach')
      }
    })
    // A provider cannot opt into the kernel loop policy merely by naming its error.
    const impostor = new Error('provider failed')
    impostor.name = 'AgentToolLoopError'
    expect(classifyAgentKernelFailure(impostor, false).error.code).toBe('internal')
  })

  it('gives cancellation precedence over late tool or provider failures', () => {
    for (const failure of [new Error('late failure'), new AgentToolLoopError('loop')]) {
      expect(classifyAgentKernelFailure(failure, true)).toMatchObject({
        phase: 'cancelled',
        message: 'Agent run cancelled',
        error: { code: 'cancelled', retryable: false, recoveryAction: 'stop' }
      })
    }
    expect(classifyAgentKernelFailure(new DOMException('cancel', 'AbortError'), false).phase).toBe(
      'cancelled'
    )
  })
})
