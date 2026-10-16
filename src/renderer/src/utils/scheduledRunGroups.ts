import type { Conversation } from '../types/app.types'

export interface ScheduledRunGroup {
  scheduleId: string
  label: string
  /** Newest run first. */
  conversations: Conversation[]
}

export type SidebarConversationEntry =
  | { kind: 'conversation'; conversation: Conversation }
  | { kind: 'schedule'; group: ScheduledRunGroup }

const RUN_SUFFIX = / · Run \d+$/

/**
 * Collapses the chats each schedule created into one entry, placed where its first chat in the
 * list was, the way Cline groups scheduled sessions. Pinned chats stay where the user put them.
 */
export function groupScheduledConversations(
  conversations: readonly Conversation[],
  scheduleNames: ReadonlyMap<string, string> = new Map()
): SidebarConversationEntry[] {
  const entries: SidebarConversationEntry[] = []
  const groups = new Map<string, ScheduledRunGroup>()
  for (const conversation of conversations) {
    const scheduleId = conversation.schedule_id
    if (!scheduleId || conversation.is_pinned) {
      entries.push({ kind: 'conversation', conversation })
      continue
    }
    let group = groups.get(scheduleId)
    if (!group) {
      group = {
        scheduleId,
        label: scheduleNames.get(scheduleId) ?? conversation.title.replace(RUN_SUFFIX, ''),
        conversations: []
      }
      groups.set(scheduleId, group)
      entries.push({ kind: 'schedule', group })
    }
    group.conversations.push(conversation)
  }
  for (const group of groups.values()) {
    group.conversations.sort(
      (a, b) =>
        (b.schedule_run_number ?? 0) - (a.schedule_run_number ?? 0) || b.created_at - a.created_at
    )
  }
  return entries
}

export function scheduledRunLabel(conversation: Conversation): string {
  return conversation.schedule_run_number
    ? `Run ${conversation.schedule_run_number}`
    : conversation.title
}
