import { isAbsolute, relative, resolve, sep } from 'path'
import { app } from 'electron'
import { getDb, getStore } from './state'
import { assertPathInside } from '../utils/paths'
import { chatIdForFolder, ensureChatFolder } from '../services/chatFolders'

const APP_ROOT = resolve(app.getAppPath())

function isInsideFolder(path: string, folder: string): boolean {
  const rel = relative(folder, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Returns the workspace root from electron-store (the trusted server-side source).
 * Never trusts a workspaceRoot value passed by the renderer.
 * Throws if no workspace is configured or if the stored path is the app directory.
 */
export function getStoredWorkspace(): string {
  const stored = getStore().get('workspacePath', null) as string | null
  if (!stored) throw new Error('No workspace folder is configured')
  const resolved = resolve(stored)
  if (resolved === APP_ROOT || resolved.startsWith(APP_ROOT + sep)) {
    throw new Error('Security: the workspace cannot be the app installation directory')
  }
  return resolved
}

/**
 * Resolves a renderer-supplied workspace against SideKick's trusted project data.
 *
 * Workspace operations must be scoped to the conversation that requested them,
 * not whichever project happens to be visible. Registered projects, detached
 * project chats, every folder of a project, and the own folders of chats without a project are
 * valid;
 * arbitrary renderer paths are rejected.
 */
export function resolveKnownWorkspace(passedRoot?: unknown): string {
  if (passedRoot === undefined || passedRoot === null || passedRoot === '') {
    return getStoredWorkspace()
  }
  if (typeof passedRoot !== 'string' || passedRoot.length > 4_096) {
    throw new Error('Invalid workspace root')
  }

  const candidate = resolve(passedRoot)
  if (candidate === APP_ROOT || candidate.startsWith(APP_ROOT + sep)) {
    throw new Error('Security: the workspace cannot be the app installation directory')
  }

  try {
    if (candidate === getStoredWorkspace()) return candidate
  } catch {
    // A background project run remains valid when no project is currently visible.
  }

  const known = getDb()
    .prepare(
      `SELECT 1 FROM projects WHERE folder_path = ?
       UNION ALL
       SELECT 1 FROM conversations WHERE home_workspace_root = ?
       UNION ALL
       SELECT 1 FROM managed_worktrees WHERE folder_path = ?
       UNION ALL
       SELECT 1 FROM project_folders WHERE folder_path = ?
       LIMIT 1`
    )
    .get(candidate, candidate, candidate, candidate)
  if (known) return candidate
  // A worktree chat works in the worktree's copies of its project's folders in that repository.
  const worktrees = getDb()
    .prepare('SELECT worktree_root FROM managed_worktrees WHERE set_aside_at IS NULL')
    .all() as Array<{ worktree_root: string }>
  if (worktrees.some(({ worktree_root }) => isInsideFolder(candidate, resolve(worktree_root)))) {
    return candidate
  }
  // A chat with no project works in its own folder, which names it.
  const chatId = chatIdForFolder(candidate)
  const chat =
    chatId &&
    getDb()
      .prepare(
        `SELECT 1 FROM conversations
         WHERE id = ? AND project_id IS NULL AND worktree_id IS NULL`
      )
      .get(chatId)
  if (!chat) throw new Error('Workspace is not associated with a SideKick project chat')
  // It is made when first used, and opening its files may come first.
  ensureChatFolder(candidate)
  return candidate
}

/**
 * Makes a folder the visible workspace. Later workspace checks trust it, so it must already be
 * one SideKick knows, never an arbitrary path from the renderer.
 */
export function setStoredWorkspace(folderPath: unknown): void {
  if (folderPath !== null && (typeof folderPath !== 'string' || !folderPath)) {
    throw new Error('Invalid workspace root')
  }
  getStore().set('workspacePath', folderPath === null ? null : resolveKnownWorkspace(folderPath))
}

/** Folders the user chose in SideKick's folder picker since it started. */
const pickedFolders = new Set<string>()

export function rememberPickedFolder(folderPath: string): void {
  pickedFolders.add(resolve(folderPath))
}

/** A new project folder must be one the user chose in the folder picker. */
export function assertPickedFolder(folderPath: string): void {
  if (!pickedFolders.has(resolve(folderPath))) {
    throw new Error('Choose the project folder in the folder picker')
  }
}

/** Refuses the app's own folder, which no project may hold. */
export function assertNotAppFolder(folderPath: string): void {
  const candidate = resolve(folderPath)
  if (candidate === APP_ROOT || candidate.startsWith(APP_ROOT + sep)) {
    throw new Error('Security: the workspace cannot be the app installation directory')
  }
}

/** Path-traversal guard: ensures filePath is inside workspaceRoot. */
export function assertInsideWorkspace(filePath: string, workspaceRoot: string): void {
  assertPathInside(workspaceRoot, filePath)
}
