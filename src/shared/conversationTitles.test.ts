import { describe, expect, it } from 'vitest'
import { isConversationTitleSource } from './conversationTitles'

describe('conversation title metadata', () => {
  it('accepts only durable title sources', () => {
    expect(isConversationTitleSource('fork')).toBe(true)
    expect(isConversationTitleSource('model')).toBe(false)
    expect(isConversationTitleSource(null)).toBe(false)
  })
})
