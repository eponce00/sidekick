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
  it('names the conversation and what it needs', () => {
    expect(attentionNotificationBody('approval', 'Fix login')).toBe(
      '“Fix login” needs your approval.'
    )
    expect(attentionNotificationBody('question', 'Fix login')).toBe(
      '“Fix login” is waiting for your answer.'
    )
    expect(attentionNotificationBody('failed', 'Fix login')).toBe(
      '“Fix login” stopped with an error.'
    )
  })

  it('does not quote a placeholder title', () => {
    expect(attentionNotificationBody('approval', 'New Conversation')).toBe(
      'A conversation needs your approval.'
    )
    expect(attentionNotificationBody('failed', null)).toBe('A conversation stopped with an error.')
  })
})

describe('shouldNotifyAttention', () => {
  const base = {
    notificationsEnabled: true,
    appFocused: true,
    shownConversationId: 'a',
    conversationId: 'a'
  }

  it('stays quiet when the user is looking at that conversation', () => {
    expect(shouldNotifyAttention(base)).toBe(false)
  })

  it('notifies when the app is in the background or another chat is showing', () => {
    expect(shouldNotifyAttention({ ...base, appFocused: false })).toBe(true)
    expect(shouldNotifyAttention({ ...base, shownConversationId: 'b' })).toBe(true)
    expect(shouldNotifyAttention({ ...base, shownConversationId: null })).toBe(true)
  })

  it('respects notifications being turned off', () => {
    expect(shouldNotifyAttention({ ...base, notificationsEnabled: false, appFocused: false })).toBe(
      false
    )
  })
})
