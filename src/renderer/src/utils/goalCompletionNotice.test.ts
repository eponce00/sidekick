import { describe, expect, it } from 'vitest'
import type { ConversationGoal } from '../../../shared/conversationGoals'
import {
  isCompletionToAnnounce,
  markCompletionAnnounced,
  observeGoal
} from './goalCompletionNotice'

function goal(id: string, status: ConversationGoal['status']): ConversationGoal {
  return {
    id,
    conversationId: 'conversation-1',
    objective: 'Build a card',
    status,
    revision: 1,
    continuationCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    blockedStreak: 0,
    plan: [],
    createdAt: 1,
    updatedAt: 1
  }
}

describe('goal completion notice', () => {
  it('announces a goal seen finishing, once', () => {
    observeGoal(goal('seen', 'active'))

    expect(isCompletionToAnnounce(goal('seen', 'completed'))).toBe(true)
    markCompletionAnnounced('seen')
    expect(isCompletionToAnnounce(goal('seen', 'completed'))).toBe(false)
  })

  it('does not re-announce a goal that was already complete when it was loaded', () => {
    // A rewind or a retry deletes the stored notice while the completed goal
    // remains; that absence is not a new completion.
    observeGoal(goal('old', 'completed'))

    expect(isCompletionToAnnounce(goal('old', 'completed'))).toBe(false)
  })
})
