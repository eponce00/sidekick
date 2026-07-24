import { describe, expect, it } from 'vitest'
import { estimateVisibleMessageTokens, formatTimestamp } from './messageFormatting'

describe('message formatting', () => {
  it('estimates visible message tokens without borrowing provider prompt usage', () => {
    expect(estimateVisibleMessageTokens('')).toBe(0)
    expect(estimateVisibleMessageTokens('one two three')).toBe(4)
    expect(estimateVisibleMessageTokens('x'.repeat(40))).toBe(10)
  })

  it('formats recent timestamps consistently', () => {
    expect(formatTimestamp(Date.now())).toBe('Just now')
  })
})
