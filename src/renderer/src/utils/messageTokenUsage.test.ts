import { describe, expect, it } from 'vitest'
import { mergeMessageTokenUsage, messageTokenUsageFromMetadata } from './messageTokenUsage'

describe('messageTokenUsageFromMetadata', () => {
  it('reads persisted nested provider telemetry', () => {
    expect(
      messageTokenUsageFromMetadata({
        usage: {
          promptTokens: 12_000,
          cachedPromptTokens: 9_000,
          completionTokens: 900,
          tokensPerSecond: 47.25,
          timeToFirstTokenMs: 1_250
        }
      })
    ).toEqual({
      promptTokens: 12_000,
      cachedPromptTokens: 9_000,
      completionTokens: 900,
      tokensPerSecond: 47.25,
      timeToFirstTokenMs: 1_250
    })
  })

  it('omits invalid or unavailable speed', () => {
    expect(
      messageTokenUsageFromMetadata({ usage: { promptTokens: 20, completionTokens: 4 } })
    ).toEqual({ promptTokens: 20, completionTokens: 4 })
    expect(messageTokenUsageFromMetadata({})).toBeUndefined()
  })

  it('combines tool-loop turns using generated-token duration', () => {
    expect(
      mergeMessageTokenUsage(
        {
          promptTokens: 100,
          cachedPromptTokens: 60,
          completionTokens: 20,
          tokensPerSecond: 10,
          timeToFirstTokenMs: 900
        },
        { promptTokens: 150, cachedPromptTokens: 120, completionTokens: 30, tokensPerSecond: 30 }
      )
    ).toEqual({
      promptTokens: 250,
      cachedPromptTokens: 180,
      completionTokens: 50,
      tokensPerSecond: 50 / 3,
      timeToFirstTokenMs: 900
    })
  })
})
