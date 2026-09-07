import { describe, expect, it } from 'vitest'
import { providerContextWindowError, providerInferenceFailure } from './providerErrors'

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
