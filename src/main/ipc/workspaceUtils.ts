import { resolve, sep } from 'path'
import { app } from 'electron'
import { getDb, getStore } from './state'
import { assertPathInside } from '../utils/paths'

const APP_ROOT = resolve(app.getAppPath())

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
 * not whichever project happens to be visible. Registered projects and detached
 * project chats are valid; arbitrary renderer paths are rejected.
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
       LIMIT 1`
    )
    .get(candidate, candidate)
  if (!known) throw new Error('Workspace is not associated with a SideKick project chat')
  return candidate
}

/** Path-traversal guard: ensures filePath is inside workspaceRoot. */
export function assertInsideWorkspace(filePath: string, workspaceRoot: string): void {
  assertPathInside(workspaceRoot, filePath)
}
