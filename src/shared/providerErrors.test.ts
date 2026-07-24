import { describe, expect, it } from 'vitest'
import { providerContextWindowError } from './providerErrors'

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
