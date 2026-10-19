import { describe, expect, it } from 'vitest'
import { formatModelPrice, formatTokenCount, modelLimitsLabel } from './modelLimits'

describe('formatTokenCount', () => {
  it('quotes binary and decimal sizes the way providers do', () => {
    expect(formatTokenCount(131_072)).toBe('128K')
    expect(formatTokenCount(40_960)).toBe('40K')
    expect(formatTokenCount(200_000)).toBe('200K')
    expect(formatTokenCount(128_000)).toBe('128K')
    expect(formatTokenCount(256_000)).toBe('256K')
    expect(formatTokenCount(65_535)).toBe('66K')
    expect(formatTokenCount(163_840)).toBe('160K')
    expect(formatTokenCount(1_048_576)).toBe('1M')
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(2_097_152)).toBe('2M')
    expect(formatTokenCount(1500)).toBe('1.5K')
    expect(formatTokenCount(512)).toBe('512')
  })
})

describe('formatModelPrice', () => {
  it('shows dollars per million tokens, and free models as free', () => {
    expect(formatModelPrice({ prompt: 0.000003, completion: 0.000015 })).toBe('$3/$15 per M')
    expect(formatModelPrice({ prompt: 0.00000015, completion: 0.0000006 })).toBe('$0.15/$0.6 per M')
    expect(formatModelPrice({ prompt: 0, completion: 0 })).toBe('Free')
  })
})

describe('modelLimitsLabel', () => {
  it('says when the context is unknown and leaves out what is not reported', () => {
    expect(modelLimitsLabel({ id: 'a', enabled: false })).toBe('Context unknown')
    expect(
      modelLimitsLabel({
        id: 'b',
        enabled: false,
        contextLength: 200_000,
        maxOutputTokens: 64_000,
        pricing: { prompt: 0.000003, completion: 0.000015 }
      })
    ).toBe('200K context · 64K output · $3/$15 per M')
  })
})
