import type Database from 'better-sqlite3'
import { conversationTitleVersionForSource } from '../../shared/conversationTitles'
import type { RemoveManagedWorktreeResult } from '../../shared/worktrees'
import { removeChatFolder } from './chatFolders'

/**
 * What the user does to a chat from its menu, shared by the window's handlers and the phone, so
 * both change a chat the same way.
 */

export function setConversationPinned(
  db: Database.Database,
  conversationId: string,
  pinned: boolean
): boolean {
  return (
    db
      .prepare('UPDATE conversations SET is_pinned = ? WHERE id = ?')
      .run(pinned ? 1 : 0, conversationId).changes > 0
  )
}

/** A title the user gave; later automatic titles leave it alone. */
export function renameConversation(
  db: Database.Database,
  conversationId: string,
  title: string,
  now = Date.now()
): boolean {
  return (
    db
      .prepare(
        `UPDATE conversations
         SET title = ?, title_source = 'user', title_version = ?, title_backfill_error = NULL,
             updated_at = ?
         WHERE id = ?`
      )
      .run(title, conversationTitleVersionForSource('user'), now, conversationId).changes === 1
  )
}

/**
 * Deletes a chat and its messages, and its own folder when it has one; a worktree its last chat
 * leaves behind goes too.
 */
export async function deleteConversation(
  db: Database.Database,
  worktrees: {
    worktreeIdFor: (conversationId: string) => string | null
    removeIfUnused: (id: string) => Promise<RemoveManagedWorktreeResult | null>
  },
  conversationId: string
): Promise<{ worktreeCleanup?: RemoveManagedWorktreeResult }> {
  const worktreeId = worktrees.worktreeIdFor(conversationId)
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId)
  db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
  try {
    removeChatFolder(conversationId)
  } catch (error) {
    // The next start removes it.
    console.warn('[Conversations] Could not remove the chat’s folder:', error)
  }
  const worktreeCleanup = worktreeId ? await worktrees.removeIfUnused(worktreeId) : null
  return worktreeCleanup ? { worktreeCleanup } : {}
}
