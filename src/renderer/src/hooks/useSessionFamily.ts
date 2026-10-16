import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SessionFamily,
  SessionFamilyMember,
  SessionMessage,
  SessionStatus
} from '../../../shared/sessions'

export interface SessionFamilyView {
  family: SessionFamily | null
  /** This chat's role in its family. Null for a chat that has none. */
  role: 'manager' | 'worker' | null
  /** This chat as a family member. */
  self: SessionFamilyMember | null
  /** Messages to and from this chat, oldest first. */
  messages: SessionMessage[]
  /** Live status by chat, for the family's members. */
  statuses: Map<string, SessionStatus>
  reload: () => Promise<void>
}

let familyLoadFailureLogged = false

const EMPTY: Omit<SessionFamilyView, 'reload'> = {
  family: null,
  role: null,
  self: null,
  messages: [],
  statuses: new Map()
}

/**
 * The family a chat belongs to, read from the main process and kept current by its change
 * events. Every family member's state comes from main, so chips are right for workers no panel
 * has mounted.
 */
export function useSessionFamily(conversationId: string | null | undefined): SessionFamilyView {
  const [view, setView] = useState<Omit<SessionFamilyView, 'reload'>>(EMPTY)
  const latestRequest = useRef(0)
  const memberIds = useRef<Set<string>>(new Set())

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latestRequest.current
    if (!conversationId || !window.api?.sessions) {
      memberIds.current = new Set()
      setView(EMPTY)
      return
    }
    try {
      const sessions = window.api.sessions
      const [family, messages, statuses] = await Promise.all([
        sessions.family(conversationId),
        sessions.messages(conversationId),
        sessions.statuses()
      ])
      if (request !== latestRequest.current) return
      const members = family ? [family.manager, ...family.workers] : []
      memberIds.current = new Set(members.map((member) => member.conversationId))
      const self = members.find((member) => member.conversationId === conversationId) ?? null
      setView({
        family,
        role: !family
          ? null
          : family.manager.conversationId === conversationId
            ? 'manager'
            : 'worker',
        self,
        messages,
        statuses: new Map(
          statuses
            .filter((status) => memberIds.current.has(status.conversationId))
            .map((status) => [status.conversationId, status])
        )
      })
    } catch (error) {
      // Until the main process serves sessions every chat would fail the same way; once is enough.
      if (!familyLoadFailureLogged)
        console.warn('[Sessions] Could not load the chat family:', error)
      familyLoadFailureLogged = true
    }
  }, [conversationId])

  useEffect(() => {
    void Promise.resolve().then(reload)
    const unsubscribe = window.api?.sessions?.onChanged((change) => {
      if (!conversationId) return
      const touchesFamily = change.conversationIds.some(
        (id) => id === conversationId || memberIds.current.has(id)
      )
      if (!touchesFamily) return
      if (change.kind === 'status' && change.statuses) {
        // A state change needs no round trip: apply it to the members it names.
        const updates = change.statuses
        setView((current) => {
          const statuses = new Map(current.statuses)
          for (const status of updates) statuses.set(status.conversationId, status)
          const withState = (member: SessionFamilyMember): SessionFamilyMember => {
            const update = statuses.get(member.conversationId)
            return update ? { ...member, state: update.state } : member
          }
          const family = current.family && {
            ...current.family,
            manager: withState(current.family.manager),
            workers: current.family.workers.map(withState)
          }
          return {
            ...current,
            family,
            self: current.self && withState(current.self),
            statuses
          }
        })
        return
      }
      void reload()
    })
    return () => unsubscribe?.()
  }, [conversationId, reload])

  return { ...view, reload }
}

/** A member's live state, preferring the latest status event over the family snapshot. */
export function memberState(
  member: SessionFamilyMember,
  statuses: Map<string, SessionStatus>
): SessionFamilyMember['state'] {
  return statuses.get(member.conversationId)?.state ?? member.state
}

/** The short name a chat goes by in its family: its handle, or its title for a manager. */
export function memberName(member: SessionFamilyMember): string {
  return member.handle || member.title
}

/** The project a chat belongs to, seen through any worktree it works in. */
function baseProjectName(member: SessionFamilyMember): string | null {
  // A worktree's project is named "<project> · <branch>".
  return member.projectName?.split(' · ')[0] ?? null
}

/**
 * The other project a worker works in, for the small tag beside its name. Null when it works in
 * the manager's project, directly or through one of its worktrees.
 */
export function familyProjectTag(
  member: SessionFamilyMember,
  manager: SessionFamilyMember | null | undefined
): string | null {
  if (!manager || member.conversationId === manager.conversationId) return null
  if (member.projectId === manager.projectId) return null
  const project = baseProjectName(member)
  return project && project !== baseProjectName(manager) ? project : null
}
