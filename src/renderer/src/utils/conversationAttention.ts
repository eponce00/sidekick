import type { ConversationAttentionReason } from '../../../shared/conversationAttention'
import { isPlaceholderConversationTitle } from './chatPanelHelpers'

export type ConversationRunStatus = 'waiting' | 'working' | 'unread'

/** One mark per sidebar row. Waiting on the user outranks working, which outranks unread. */
export function conversationRunStatus(
  conversationId: string,
  sets: {
    waiting: ReadonlySet<string>
    busy: ReadonlySet<string>
    unread: ReadonlySet<string>
  }
): ConversationRunStatus | null {
  if (sets.waiting.has(conversationId)) return 'waiting'
  if (sets.busy.has(conversationId)) return 'working'
  if (sets.unread.has(conversationId)) return 'unread'
  return null
}

export const CONVERSATION_RUN_STATUS_LABELS: Record<ConversationRunStatus, string> = {
  waiting: 'Waiting for your approval or answer',
  working: 'Agent working in background',
  unread: 'Completed response unread'
}

export function attentionNotificationBody(
  reason: ConversationAttentionReason,
  title: string | null | undefined
): string {
  const name =
    title && !isPlaceholderConversationTitle(title) ? `“${title.trim()}”` : 'A conversation'
  if (reason === 'approval') return `${name} needs your approval.`
  if (reason === 'question') return `${name} is waiting for your answer.`
  return `${name} stopped with an error.`
}

/** Notify unless the user is already looking at that conversation. */
export function shouldNotifyAttention(input: {
  notificationsEnabled: boolean
  appFocused: boolean
  shownConversationId: string | null
  conversationId: string
}): boolean {
  if (!input.notificationsEnabled) return false
  return !input.appFocused || input.shownConversationId !== input.conversationId
}
