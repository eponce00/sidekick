import { describe, expect, it } from 'vitest'
import {
  providerConnectionFailureKind,
  providerConnectionFailureMessage,
  providerContextWindowError,
  providerImageLimitError,
  providerInferenceFailure
} from './providerErrors'

describe('providerConnectionFailureMessage', () => {
  const failure = (message: string, code?: string): TypeError =>
    new TypeError(message, code ? { cause: Object.assign(new Error('x'), { code }) } : undefined)

  it('says the server dropped the reply, naming it, instead of the socket error', () => {
    const message = providerConnectionFailureMessage(
      failure('terminated', 'UND_ERR_SOCKET'),
      'http://127.0.0.1:4000/v1'
    )
    expect(message).toBe(
      'Lost the connection to the model server at 127.0.0.1:4000 while it was replying; the server stopped or restarted. (UND_ERR_SOCKET)'
    )
    expect(providerConnectionFailureKind(message)).toBe('dropped')
  })

  it('says the server could not be reached when nothing listens', () => {
    const message = providerConnectionFailureMessage(
      failure('fetch failed', 'ECONNREFUSED'),
      'http://localhost:11434'
    )
    expect(message).toBe(
      'Could not reach the model server at localhost:11434. Check that it is running. (ECONNREFUSED)'
    )
    expect(providerConnectionFailureKind(message)).toBe('unreachable')
  })

  it('leaves other failures to their own message', () => {
    expect(providerConnectionFailureMessage(new Error('Bad model'), 'http://x.test')).toBeNull()
    expect(providerConnectionFailureMessage('nope', 'http://x.test')).toBeNull()
    expect(providerConnectionFailureKind('HTTP 500')).toBeNull()
  })
})

describe('providerInferenceFailure', () => {
  it('recognizes explicit GPU allocation exhaustion and engine death', () => {
    expect(providerInferenceFailure('CUDA out of memory. Tried to allocate 144 MiB')).toBe(
      'gpu-memory-exhausted'
    )
    expect(providerInferenceFailure('torch.OutOfMemoryError: GPU 0')).toBe('gpu-memory-exhausted')
    expect(providerInferenceFailure('litellm.InternalServerError: EngineDeadError')).toBe(
      'engine-unavailable'
    )
    expect(providerInferenceFailure('Engine core encountered an issue. See traceback')).toBe(
      'engine-unavailable'
    )
  })
  it('does not attribute ambiguous timeouts, CPU errors or other CUDA failures to GPU capacity', () => {
    for (const message of [
      null,
      '',
      'Request timed out',
      'JavaScript heap out of memory',
      'CUDA illegal memory access',
      'Invalid API key',
      'GPU temperature is high'
    ])
      expect(providerInferenceFailure(message)).toBeNull()
  })
})

describe('providerContextWindowError', () => {
  it('extracts LiteLLM context overflow details', () => {
    expect(
      providerContextWindowError(
        "ContextWindowExceededError: This model's maximum context length is 262144 tokens. However, you requested 32000 output tokens and your prompt contains at least 230145 input tokens."
      )
    ).toEqual({
      contextLength: 262_144,
      requestedOutputTokens: 32_000,
      inputTokens: 230_145
    })
  })

  it('recognizes provider variants without misclassifying ordinary errors', () => {
    expect(
      providerContextWindowError('prompt is too long: 205000 tokens > 200000 maximum')
    ).toEqual({
      contextLength: undefined,
      requestedOutputTokens: undefined,
      inputTokens: 205_000
    })
    expect(providerContextWindowError('Authentication failed: invalid API key')).toBeNull()
    expect(
      providerContextWindowError('Too many tokens per minute; retry after 10 seconds')
    ).toBeNull()
  })
})

describe('providerImageLimitError', () => {
  it('extracts image limits without matching unrelated image failures', () => {
    expect(providerImageLimitError('At most 2 image(s) may be provided in one prompt.')).toEqual({
      maxImages: 2
    })
    expect(providerImageLimitError('Image download failed with status 404')).toBeNull()
  })
})
