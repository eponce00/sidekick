import { promises as fsPromises } from 'fs'
import { checkGitAvailable, cleanupOldCheckpoints } from '../services/checkpoints'
import { appState, getStore } from '../ipc/state'

export async function initializeWorkspaceState(): Promise<string | null> {
  const store = getStore()
  const savedWorkspacePath = store.get('workspacePath', null) as string | null

  const gitVersion = await checkGitAvailable()
  appState.gitAvailable = gitVersion !== null
  if (gitVersion) console.log('[Checkpoints] git available:', gitVersion)
  else console.warn('[Checkpoints] git not found on PATH — shadow checkpoints disabled')

  if (!savedWorkspacePath) return null
  try {
    await fsPromises.access(savedWorkspacePath)
  } catch {
    store.set('workspacePath', null)
    console.log('[Checkpoints] Cleared stale workspace path:', savedWorkspacePath)
    return null
  }

  try {
    await cleanupOldCheckpoints(savedWorkspacePath)
  } catch (error) {
    console.warn('[Checkpoints] Cleanup error:', error)
  }
  return savedWorkspacePath
}
