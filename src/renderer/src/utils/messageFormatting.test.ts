import { describe, expect, it } from 'vitest'
import { estimateVisibleMessageTokens } from './messageFormatting'

describe('message formatting', () => {
  it('estimates visible message tokens without borrowing provider prompt usage', () => {
    expect(estimateVisibleMessageTokens('')).toBe(0)
    expect(estimateVisibleMessageTokens('one two three')).toBe(4)
    expect(estimateVisibleMessageTokens('x'.repeat(40))).toBe(10)
  })
})
