import { useEffect, useState } from 'react'

/**
 * The folder a chat with no project works in, where its files and History are; null for a chat
 * in a project, and for one detached from its project.
 */
export function useChatFolder(
  conversationId: string | null,
  projectFolder: string | null
): string | null {
  const [folder, setFolder] = useState<{ conversationId: string; path: string | null } | null>(null)
  useEffect(() => {
    if (!conversationId || projectFolder) return
    let cancelled = false
    window.api.projects.getConversationContext(conversationId).then(
      (context) => {
        if (cancelled) return
        setFolder({ conversationId, path: context.chatFolder ? context.workspaceRoot : null })
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [conversationId, projectFolder])
  return !projectFolder && folder?.conversationId === conversationId ? folder.path : null
}
