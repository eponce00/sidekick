import { sessionLinkFromConversation, type SessionState } from '../../../shared/sessions'
import type { Conversation } from '../types/app.types'
import type { ConversationRunStatus } from './conversationAttention'

/** The mark a sidebar row shows. `unread` is the solid dot of a chat that finished unseen. */
export type SidebarDot = 'waiting' | 'failed' | 'working' | 'queued' | 'unread' | 'stopped'

/** Most urgent first, as a collapsed family rolls its workers up onto the manager's row. */
const DOT_URGENCY: readonly SidebarDot[] = [
  'waiting',
  'failed',
  'working',
  'queued',
  'unread',
  'stopped'
]

export const SIDEBAR_DOT_LABELS: Record<SidebarDot, string> = {
  waiting: 'Waiting for your approval or answer',
  failed: 'Stopped with an error',
  working: 'Agent working in background',
  queued: 'Waiting to start',
  unread: 'Completed response unread',
  stopped: 'Stopped'
}

/** How each mark reads in a family's one-line summary, such as "2 working · 1 needs you". */
const ROLL_UP_WORDS: Record<SidebarDot, string> = {
  waiting: 'needs you',
  failed: 'failed',
  working: 'working',
  queued: 'queued',
  unread: 'done',
  stopped: 'stopped'
}

/**
 * One row's mark. A pending approval or question from the attention tracker always shows; then
 * the main process's session state when it has one; then what the renderer knows today.
 */
export function sidebarDot(
  runStatus: ConversationRunStatus | null,
  sessionState?: SessionState
): SidebarDot | null {
  if (runStatus === 'waiting') return 'waiting'
  switch (sessionState) {
    case 'waiting':
    case 'failed':
    case 'working':
    case 'queued':
    case 'stopped':
      return sessionState
    case 'done':
      return 'unread'
  }
  return runStatus
}

/** The status filter a mark falls under, so a filter lists exactly the rows showing its mark. */
export function dotFilterStatus(dot: SidebarDot | null): ConversationRunStatus | null {
  if (dot === 'waiting' || dot === 'failed') return 'waiting'
  if (dot === 'working' || dot === 'queued') return 'working'
  if (dot === 'unread') return 'unread'
  return null
}

export function mostUrgentDot(dots: Iterable<SidebarDot | null>): SidebarDot | null {
  let best = DOT_URGENCY.length
  for (const dot of dots) if (dot) best = Math.min(best, DOT_URGENCY.indexOf(dot))
  return DOT_URGENCY[best] ?? null
}

/** "2 working · 1 needs you", most urgent first; empty when no worker shows a mark. */
export function familyRollUpLabel(dots: Iterable<SidebarDot | null>): string {
  const counts = new Map<SidebarDot, number>()
  for (const dot of dots) if (dot) counts.set(dot, (counts.get(dot) ?? 0) + 1)
  return DOT_URGENCY.filter((dot) => counts.has(dot))
    .map((dot) => `${counts.get(dot)} ${ROLL_UP_WORDS[dot]}`)
    .join(' · ')
}

export interface SessionFamilyIndex {
  /** Each manager's listed workers, in the order they were started. */
  workersByManager: ReadonlyMap<string, readonly Conversation[]>
  /** Chats shown under their manager instead of on their own. */
  nestedIds: ReadonlySet<string>
}

const NO_WORKERS: readonly Conversation[] = []

/**
 * Finds which listed chats nest under another. A worker nests under the chat that started it
 * when that chat is listed too, whichever project each is in; once its manager is deleted or
 * it is detached, it is an ordinary row again. A chain that loops back nests nowhere.
 */
export function indexSessionFamilies(conversations: readonly Conversation[]): SessionFamilyIndex {
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  const managerOf = (conversation: Conversation): string | null => {
    const manager = sessionLinkFromConversation(conversation).startedByConversationId
    return manager && manager !== conversation.id && byId.has(manager) ? manager : null
  }
  const workersByManager = new Map<string, Conversation[]>()
  const nestedIds = new Set<string>()
  for (const conversation of conversations) {
    const manager = managerOf(conversation)
    if (!manager) continue
    // Walk up to a root; a cycle has none and its chats stay where they are.
    const seen = new Set([conversation.id])
    let ancestor: string | null = manager
    while (ancestor && !seen.has(ancestor)) {
      seen.add(ancestor)
      ancestor = managerOf(byId.get(ancestor)!)
    }
    if (ancestor) continue
    nestedIds.add(conversation.id)
    const workers = workersByManager.get(manager) ?? []
    workers.push(conversation)
    workersByManager.set(manager, workers)
  }
  for (const workers of workersByManager.values()) {
    workers.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
  }
  return { workersByManager, nestedIds }
}

export function familyWorkers(
  index: SessionFamilyIndex,
  managerId: string
): readonly Conversation[] {
  return index.workersByManager.get(managerId) ?? NO_WORKERS
}

/** Every chat in a manager's family below it, depth first. */
export function familyDescendants(index: SessionFamilyIndex, managerId: string): Conversation[] {
  return familyWorkers(index, managerId).flatMap((worker) => [
    worker,
    ...familyDescendants(index, worker.id)
  ])
}

/**
 * The rows top to bottom: each listed chat followed by its shown workers. A collapsed family
 * hides its workers; `include` drops workers that a filter does not match.
 */
export function expandFamilies(
  ids: readonly string[],
  index: SessionFamilyIndex,
  isCollapsed: (managerId: string) => boolean,
  include: (conversation: Conversation) => boolean = () => true
): string[] {
  const order: string[] = []
  const visit = (id: string): void => {
    order.push(id)
    if (isCollapsed(id)) return
    for (const worker of familyWorkers(index, id)) {
      if (include(worker) || familyDescendants(index, worker.id).some(include)) visit(worker.id)
    }
  }
  for (const id of ids) visit(id)
  return order
}
