import { useEffect, useState } from 'react'
import type { WorkspaceFolder } from '../../../shared/projects'

const NO_FOLDERS: WorkspaceFolder[] = []

/**
 * The other folders a chat works in besides its workspace folder, as the main process resolves
 * them (a chat in a worktree has its own set). `projectFolders` is the project's list from the
 * sidebar: the chat's set is read again whenever it changes.
 */
export function useProjectFolders(
  conversationId: string | null,
  workspaceFolder: string | null,
  projectFolders: readonly WorkspaceFolder[] | undefined
): WorkspaceFolder[] {
  const [loaded, setLoaded] = useState<{ key: string; folders: WorkspaceFolder[] } | null>(null)
  const projectKey = JSON.stringify(projectFolders ?? [])
  const key = `${conversationId}\n${workspaceFolder}\n${projectKey}`
  useEffect(() => {
    if (!conversationId || !workspaceFolder) return
    let cancelled = false
    window.api.projects.getConversationContext(conversationId).then(
      (context) => {
        if (!cancelled && context.workspaceRoot === workspaceFolder) {
          setLoaded({ key, folders: context.folders ?? [] })
        }
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [conversationId, workspaceFolder, key])
  if (!workspaceFolder) return NO_FOLDERS
  if (loaded?.key === key) return loaded.folders
  // Until the chat's own set arrives, the project's list stands in for it.
  return (projectFolders as WorkspaceFolder[] | undefined) ?? NO_FOLDERS
}
