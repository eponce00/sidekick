import type { ConversationGoal } from '../../../shared/conversationGoals'

/**
 * Goals this app session has seen before they finished. A completion notice is
 * the report of a goal finishing, so only a goal seen unfinished is announced,
 * and only once.
 *
 * Deciding from the conversation's messages alone re-announced old goals: a
 * rewind or a retry deletes the stored notice while the completed goal stays,
 * and the missing notice was taken as a completion still to report.
 */
const unfinishedGoalIds = new Set<string>()

export function observeGoal(goal: ConversationGoal | null | undefined): void {
  if (goal && goal.status !== 'completed' && goal.status !== 'cleared') {
    unfinishedGoalIds.add(goal.id)
  }
}

export function isCompletionToAnnounce(goal: ConversationGoal | null | undefined): boolean {
  return goal?.status === 'completed' && unfinishedGoalIds.has(goal.id)
}

export function markCompletionAnnounced(goalId: string): void {
  unfinishedGoalIds.delete(goalId)
}
