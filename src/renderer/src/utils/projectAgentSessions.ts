import type { CollaborationAgentSession, CollaborationGroup } from '../../../shared/collaboration'

export interface ProjectAgentSessionLink {
  group: CollaborationGroup
  session: CollaborationAgentSession
}

export function groupAgentSessionsByProject(
  groups: CollaborationGroup[]
): Map<string, ProjectAgentSessionLink[]> {
  const byProject = new Map<string, ProjectAgentSessionLink[]>()
  for (const group of groups) {
    if (group.status !== 'active') continue
    for (const session of group.agentSessions) {
      const sessions = byProject.get(session.projectId) || []
      sessions.push({ group, session })
      byProject.set(session.projectId, sessions)
    }
  }
  return byProject
}
