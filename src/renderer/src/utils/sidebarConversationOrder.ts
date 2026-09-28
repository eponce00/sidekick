import type { Conversation, Project } from '../types/app.types'

/**
 * Conversations in the order the sidebar lists them: each project's chats under
 * it, then standalone chats. Chats inside a collapsed project are not visible,
 * so they are skipped, unless the whole sidebar is collapsed and nothing is.
 */
export function sidebarConversationOrder(
  conversations: readonly Conversation[],
  projects: readonly Project[],
  hiddenProjectIds: ReadonlySet<string> = new Set()
): string[] {
  const byProject = new Map<string, string[]>()
  const standalone: string[] = []
  for (const conversation of conversations) {
    if (!conversation.project_id) {
      standalone.push(conversation.id)
      continue
    }
    const ids = byProject.get(conversation.project_id) ?? []
    ids.push(conversation.id)
    byProject.set(conversation.project_id, ids)
  }
  const order: string[] = []
  for (const project of projects) {
    if (hiddenProjectIds.has(project.id)) continue
    order.push(...(byProject.get(project.id) ?? []))
  }
  return [...order, ...standalone]
}

/** The conversation before or after the current one, wrapping at the ends. */
export function adjacentConversationId(
  order: readonly string[],
  currentId: string | null,
  direction: 1 | -1
): string | null {
  if (!order.length) return null
  const index = currentId ? order.indexOf(currentId) : -1
  if (index === -1) return direction === 1 ? order[0] : order[order.length - 1]
  return order[(index + direction + order.length) % order.length]
}
