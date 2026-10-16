import { createContext, useContext } from 'react'

/**
 * Who a worker chat is, for cards that must say so. An approval in a worker names the worker,
 * its manager and where it works, so the user never approves without knowing which chat asks.
 */
export interface WorkerChatIdentity {
  workerName: string
  managerTitle: string
  /** Where the worker works, as "worktree sidekick/schedules". */
  workplace: string | null
}

export const WorkerChatContext = createContext<WorkerChatIdentity | null>(null)

export function useWorkerChatIdentity(): WorkerChatIdentity | null {
  return useContext(WorkerChatContext)
}
