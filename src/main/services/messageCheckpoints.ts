import type Database from 'better-sqlite3'
import { parseHistoryPoints, type HistoryPoint } from '../../shared/workspaceHistory'

/**
 * Adds History points to a reply's list, one per folder: a later point for a folder replaces an
 * earlier one, since a reply has one set of changes in each folder.
 */
export function addMessageCheckpoints(
  db: Database.Database,
  messageId: string,
  conversationId: string,
  points: readonly HistoryPoint[]
): void {
  if (!points.length) return
  const row = db
    .prepare('SELECT checkpoints FROM messages WHERE id = ? AND conversation_id = ?')
    .get(messageId, conversationId) as { checkpoints: string | null } | undefined
  if (!row) return
  const roots = new Set(points.map(({ workspaceRoot }) => workspaceRoot))
  const merged = [
    ...parseHistoryPoints(row.checkpoints).filter(({ workspaceRoot }) => !roots.has(workspaceRoot)),
    ...points
  ]
  db.prepare('UPDATE messages SET checkpoints = ? WHERE id = ? AND conversation_id = ?').run(
    JSON.stringify(merged),
    messageId,
    conversationId
  )
}
