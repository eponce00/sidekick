import type { SessionFamilyMember, SessionState } from '../../../shared/sessions'
import type { ManagedWorktreeSummary } from '../../../shared/worktrees'

const STATE_LABELS: Record<SessionState, string> = {
  queued: 'Queued',
  working: 'Working',
  waiting: 'Needs you',
  done: 'Done',
  idle: 'Idle',
  failed: 'Failed',
  stopped: 'Stopped'
}

/** A chat's state in the words every family surface uses. */
export function sessionStateLabel(state: SessionState): string {
  return STATE_LABELS[state]
}

/** Where a worker works, in the words its header and approval cards use. */
export function workerWorkplace(
  member: Pick<SessionFamilyMember, 'workIn'>,
  worktree: ManagedWorktreeSummary | null | undefined
): string | null {
  if (worktree) return `worktree ${worktree.branch}`
  if (member.workIn === 'read-only') return "the manager's folder, read-only"
  if (member.workIn === 'folder') return "the manager's folder"
  return null
}
