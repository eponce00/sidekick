import { describe, expect, it } from 'vitest'
import {
  attentionNotificationBody,
  conversationRunStatus,
  shouldNotifyAttention
} from './conversationAttention'

describe('conversationRunStatus', () => {
  const sets = {
    waiting: new Set(['a']),
    busy: new Set(['a', 'b']),
    unread: new Set(['a', 'b', 'c'])
  }

  it('ranks waiting on you above working, and working above unread', () => {
    expect(conversationRunStatus('a', sets)).toBe('waiting')
    expect(conversationRunStatus('b', sets)).toBe('working')
    expect(conversationRunStatus('c', sets)).toBe('unread')
    expect(conversationRunStatus('d', sets)).toBeNull()
  })
})

describe('attentionNotificationBody', () => {
  it('does not quote a placeholder title', () => {
    expect(attentionNotificationBody('approval', 'Fix login')).toContain('Fix login')
    expect(attentionNotificationBody('approval', 'New Conversation')).not.toContain(
      'New Conversation'
    )
  })
})

describe('shouldNotifyAttention', () => {
  const base = {
    notificationsEnabled: true,
    appFocused: true,
    shownConversationId: 'a',
    conversationId: 'a'
  }

  it('notifies unless the user is looking at that chat or turned notifications off', () => {
    expect(shouldNotifyAttention(base)).toBe(false)
    expect(shouldNotifyAttention({ ...base, appFocused: false })).toBe(true)
    expect(shouldNotifyAttention({ ...base, shownConversationId: 'b' })).toBe(true)
    expect(shouldNotifyAttention({ ...base, notificationsEnabled: false, appFocused: false })).toBe(
      false
    )
  })
})
