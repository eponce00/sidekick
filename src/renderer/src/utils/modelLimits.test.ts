import { describe, expect, it } from 'vitest'
import { formatModelPrice, formatTokenCount } from './modelLimits'

describe('formatTokenCount', () => {
  it('quotes binary and decimal sizes the way providers do', () => {
    expect(formatTokenCount(131_072)).toBe('128K')
    expect(formatTokenCount(128_000)).toBe('128K')
    expect(formatTokenCount(1_048_576)).toBe('1M')
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(1500)).toBe('1.5K')
  })
})

describe('formatModelPrice', () => {
  it('shows dollars per million tokens, and free models as free', () => {
    expect(formatModelPrice({ prompt: 0.000003, completion: 0.000015 })).toBe('$3/$15 per M')
    expect(formatModelPrice({ prompt: 0.00000015, completion: 0.0000006 })).toBe('$0.15/$0.6 per M')
    expect(formatModelPrice({ prompt: 0, completion: 0 })).toBe('Free')
  })
})
