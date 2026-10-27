import { describe, expect, it } from 'vitest'
import {
  providerConnectionFailureKind,
  providerConnectionFailureMessage,
  providerContextWindowError,
  providerImageLimitError,
  providerInferenceFailure,
  providerOutputLimitError,
  providerStreamDropped,
  redactProviderCredentials
} from './providerErrors'

describe('providerConnectionFailureMessage', () => {
  const failure = (message: string, code?: string): TypeError =>
    new TypeError(message, code ? { cause: Object.assign(new Error('x'), { code }) } : undefined)

  it('says the server dropped the reply, naming it, instead of the socket error', () => {
    const message = providerConnectionFailureMessage(
      failure('terminated', 'UND_ERR_SOCKET'),
      'http://127.0.0.1:4000/v1'
    )
    expect(message).toContain('127.0.0.1:4000')
    expect(providerConnectionFailureKind(message)).toBe('dropped')
  })

  it('says the server could not be reached when nothing listens', () => {
    const message = providerConnectionFailureMessage(
      failure('fetch failed', 'ECONNREFUSED'),
      'http://localhost:11434'
    )
    expect(providerConnectionFailureKind(message)).toBe('unreachable')
  })

  it('says the server went silent when Node gives up waiting, instead of "fetch failed"', () => {
    // Node's fetch waits five minutes for response headers; the run failed as "internal".
    const headers = providerConnectionFailureMessage(
      failure('fetch failed', 'UND_ERR_HEADERS_TIMEOUT'),
      'http://127.0.0.1:4000/v1'
    )
    expect(providerConnectionFailureKind(headers)).toBe('timed-out')
    const body = providerConnectionFailureMessage(
      failure('terminated', 'UND_ERR_BODY_TIMEOUT'),
      'http://127.0.0.1:4000/v1'
    )
    expect(providerConnectionFailureKind(body)).toBe('timed-out')
  })

  it('leaves other failures to their own message', () => {
    expect(providerConnectionFailureMessage(new Error('Bad model'), 'http://x.test')).toBeNull()
    expect(providerConnectionFailureMessage('nope', 'http://x.test')).toBeNull()
    expect(providerConnectionFailureKind('HTTP 500')).toBeNull()
  })
})

describe('providerStreamDropped', () => {
  it('recognizes a closed connection and a stream that ended before the reply did', () => {
    expect(
      providerStreamDropped(
        'Lost the connection to the model server at 127.0.0.1:4000 while it was replying; the server stopped or restarted. (UND_ERR_SOCKET)'
      )
    ).toBe(true)
    expect(providerStreamDropped('Provider stream ended before completion')).toBe(true)
    expect(providerStreamDropped('Ollama stream ended before its terminal event')).toBe(true)
    expect(providerStreamDropped('Anthropic stream ended before its terminal event')).toBe(true)
  })

  it('leaves a server that cannot be reached, went silent, or refused the request alone', () => {
    expect(
      providerStreamDropped(
        'Could not reach the model server at localhost:11434. Check that it is running. (ECONNREFUSED)'
      )
    ).toBe(false)
    expect(
      providerStreamDropped(
        'The model server at 127.0.0.1:4000 went silent for 5 minutes in the middle of its reply, so SideKick stopped waiting. (UND_ERR_BODY_TIMEOUT)'
      )
    ).toBe(false)
    expect(providerStreamDropped('HTTP 502')).toBe(false)
    expect(providerStreamDropped(undefined)).toBe(false)
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

  it('reads a prompt-plus-reply overflow that names no window in words', () => {
    // Seen through LiteLLM; it failed the run instead of compacting and retrying.
    expect(
      providerContextWindowError(
        'litellm.BadRequestError: OpenAIException - prompt (99950 tokens) + max tokens (32768) exceeds the context (131072); requests are never truncated'
      )
    ).toEqual({ contextLength: 131_072, requestedOutputTokens: 32_768, inputTokens: 99_950 })
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

describe('providerOutputLimitError', () => {
  it('reads the most a reply may hold from Groq, OpenAI and Anthropic refusals', () => {
    expect(
      providerOutputLimitError(
        '`max_tokens` must be less than or equal to `16384`, the maximum value for `max_tokens` is less than the `context_window` for this model'
      )
    ).toEqual({ maxOutputTokens: 16_384 })
    expect(
      providerOutputLimitError(
        'max_tokens is too large: 32768. This model supports at most 4096 completion tokens, whereas you provided 32768.'
      )
    ).toEqual({ maxOutputTokens: 4_096 })
    expect(
      providerOutputLimitError(
        'max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens for claude-test'
      )
    ).toEqual({ maxOutputTokens: 64_000 })
  })

  it('does not mistake context overflows or other refusals for a reply limit', () => {
    for (const message of [
      null,
      "This model's maximum context length is 49152 tokens. However, you requested 49153 tokens (16385 in the messages, 32768 in the completion).",
      'max_tokens must be at least 1',
      'Invalid API key'
    ])
      expect(providerOutputLimitError(message)).toBeNull()
  })
})

describe('redactProviderCredentials', () => {
  it('masks keys and key hashes a gateway echoes in its refusal', () => {
    expect(
      redactProviderCredentials(
        'Authentication Error, Invalid proxy server token passed. Received API Key = sk-...wxyz, Key Hash (Token) =0123456789abcdef. Unable to find token in cache or `LiteLLM_VerificationTokenTable`'
      )
    ).toBe(
      'Authentication Error, Invalid proxy server token passed. Received API Key = [redacted], Key Hash (Token) =[redacted] Unable to find token in cache or `LiteLLM_VerificationTokenTable`'
    )
    expect(redactProviderCredentials('Authorization: Bearer abc.def')).toBe(
      'Authorization: Bearer [redacted]'
    )
  })
})
