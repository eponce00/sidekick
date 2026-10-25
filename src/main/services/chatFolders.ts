import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type Database from 'better-sqlite3'

/**
 * A chat with no project works in a folder of its own inside SideKick's data, so its file and
 * command tools, downloads and History have somewhere to act that is not the user's home folder.
 * The folder is named by the chat's id, made when something first works in it, and removed with
 * the chat.
 */
let chatFoldersRoot: string | null = null

// Ids come from SideKick, but a renderer-supplied one must still never name a path.
const CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/

export function configureChatFoldersRoot(root: string): void {
  chatFoldersRoot = resolve(root)
}

/** The chat's own folder, or null when none is configured or the id cannot name one. */
export function chatFolderPath(conversationId: string): string | null {
  if (!chatFoldersRoot || !CHAT_ID.test(conversationId)) return null
  return join(chatFoldersRoot, conversationId)
}

/** The chat whose own folder this exactly is, if it is one. */
export function chatIdForFolder(folder: string): string | null {
  if (!chatFoldersRoot) return null
  const candidate = resolve(folder)
  if (dirname(candidate) !== chatFoldersRoot) return null
  const id = candidate.slice(chatFoldersRoot.length + 1)
  return CHAT_ID.test(id) ? id : null
}

export function ensureChatFolder(folder: string): void {
  if (chatIdForFolder(folder)) mkdirSync(folder, { recursive: true })
}

/** A fork starts with the files its chat had made, so it can go on working with them. */
export function copyChatFolder(fromConversationId: string, toConversationId: string): void {
  const from = chatFolderPath(fromConversationId)
  const to = chatFolderPath(toConversationId)
  if (!from || !to || !existsSync(from)) return
  cpSync(from, to, { recursive: true, errorOnExist: false, force: false })
}

export function removeChatFolder(conversationId: string): void {
  const folder = chatFolderPath(conversationId)
  if (folder) rmSync(folder, { recursive: true, force: true })
}

/** Removes the folders of chats that no longer exist, however they were deleted. */
export function removeOrphanChatFolders(db: Database.Database): void {
  if (!chatFoldersRoot || !existsSync(chatFoldersRoot)) return
  const exists = db.prepare('SELECT 1 FROM conversations WHERE id = ?')
  for (const entry of readdirSync(chatFoldersRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !CHAT_ID.test(entry.name) || exists.get(entry.name)) continue
    try {
      rmSync(join(chatFoldersRoot, entry.name), { recursive: true, force: true })
    } catch (error) {
      console.warn('[ChatFolders] Could not remove a deleted chat’s folder:', error)
    }
  }
}
