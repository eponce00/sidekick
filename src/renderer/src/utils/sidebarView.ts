import type { CollaborationGroup } from '../../../shared/collaboration'
import type { Conversation } from '../types/app.types'
import type { ConversationRunStatus } from './conversationAttention'

/** Folders lists chats under their project; Recent lists them by last activity. */
export type SidebarView = 'folders' | 'recent'

export const SIDEBAR_VIEW_STORAGE_KEY = 'sidebarView'

export function storedSidebarView(value: string | null): SidebarView {
  return value === 'recent' ? 'recent' : 'folders'
}

export type SidebarStatusFilter = 'all' | ConversationRunStatus

export const SIDEBAR_STATUS_FILTERS: readonly SidebarStatusFilter[] = [
  'all',
  'waiting',
  'working',
  'unread'
]

export const SIDEBAR_STATUS_FILTER_LABELS: Record<SidebarStatusFilter, string> = {
  all: 'All chats',
  waiting: 'Needs attention',
  working: 'Working',
  unread: 'Unread'
}

/** Rows match on the one mark they show, so a filter never lists a row under another mark. */
export function matchesStatusFilter(
  status: ConversationRunStatus | null,
  filter: SidebarStatusFilter
): boolean {
  return filter === 'all' || status === filter
}

/** A paused mission waits for the user to resume it, so it needs attention. */
export function collaborationGroupStatus(group: CollaborationGroup): ConversationRunStatus | null {
  if (group.activeMissionId) return group.activeMissionStatus === 'paused' ? 'waiting' : 'working'
  return group.unreadCompletionAt ? 'unread' : null
}

export function agentSessionStatus(
  session: CollaborationGroup['agentSessions'][number]
): ConversationRunStatus | null {
  if (['queued', 'working'].includes(session.activeRunStatus || '')) return 'working'
  return session.unreadCompletionAt ? 'unread' : null
}

export type RecentBucket = 'pinned' | 'today' | 'yesterday' | 'week' | 'older'

export interface RecentConversationGroup {
  bucket: RecentBucket
  label: string
  conversations: Conversation[]
}

const RECENT_BUCKET_LABELS: Record<RecentBucket, string> = {
  pinned: 'Pinned',
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Previous 7 days',
  older: 'Older'
}

/**
 * Pinned chats first, then the rest by last activity under local calendar-day
 * headings. Days come from the calendar, not 24-hour steps, so a chat from
 * 11 pm stays "Yesterday" at 1 am and daylight-saving days stay whole.
 */
export function groupConversationsByRecency(
  conversations: readonly Conversation[],
  now: number
): RecentConversationGroup[] {
  const today = new Date(now)
  const dayStart = (daysAgo: number): number =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo).getTime()
  const startOfToday = dayStart(0)
  const startOfYesterday = dayStart(1)
  const startOfWeek = dayStart(7)
  const buckets = new Map<RecentBucket, Conversation[]>(
    (Object.keys(RECENT_BUCKET_LABELS) as RecentBucket[]).map((bucket) => [bucket, []])
  )
  const byActivity = [...conversations].sort((a, b) => b.updated_at - a.updated_at)
  for (const conversation of byActivity) {
    const bucket: RecentBucket = conversation.is_pinned
      ? 'pinned'
      : conversation.updated_at >= startOfToday
        ? 'today'
        : conversation.updated_at >= startOfYesterday
          ? 'yesterday'
          : conversation.updated_at >= startOfWeek
            ? 'week'
            : 'older'
    buckets.get(bucket)!.push(conversation)
  }
  return [...buckets.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([bucket, items]) => ({
      bucket,
      label: RECENT_BUCKET_LABELS[bucket],
      conversations: items
    }))
}
