import { useCallback, useEffect, useRef, useState } from 'react'
import type { ManagedWorktreeSummary } from '../../../shared/worktrees'

/**
 * SideKick's worktrees, for labelling chats and projects that work in one. The list runs Git in
 * every worktree, so it reloads only when asked, not on every render.
 */
export function useManagedWorktrees(): {
  worktrees: ManagedWorktreeSummary[]
  refreshWorktrees: () => Promise<void>
} {
  const [worktrees, setWorktrees] = useState<ManagedWorktreeSummary[]>([])
  const latestRequest = useRef(0)

  const refreshWorktrees = useCallback(async (): Promise<void> => {
    const request = ++latestRequest.current
    try {
      const listed = await window.api.worktrees.list()
      if (request === latestRequest.current) setWorktrees(listed)
    } catch (error) {
      console.warn('[Worktrees] Could not list worktrees:', error)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(refreshWorktrees)
  }, [refreshWorktrees])

  return { worktrees, refreshWorktrees }
}

const WORK_IN_KEY = 'newChatWorkIn'

export function storedWorkInChoice(): 'folder' | 'worktree' {
  try {
    return window.localStorage.getItem(WORK_IN_KEY) === 'worktree' ? 'worktree' : 'folder'
  } catch {
    return 'folder'
  }
}

export function rememberWorkInChoice(choice: 'folder' | 'worktree'): void {
  try {
    window.localStorage.setItem(WORK_IN_KEY, choice)
  } catch {
    // A preference that cannot be saved only means asking again next time.
  }
}
