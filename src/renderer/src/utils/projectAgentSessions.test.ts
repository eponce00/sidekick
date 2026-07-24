import { describe, expect, it } from 'vitest'
import type { CollaborationGroup } from '../../../shared/collaboration'
import { groupAgentSessionsByProject } from './projectAgentSessions'

function group(
  id: string,
  status: CollaborationGroup['status'],
  projects: string[]
): CollaborationGroup {
  return {
    id,
    title: `Group ${id}`,
    description: null,
    status,
    createdAt: 1,
    updatedAt: 1,
    activeMissionId: null,
    activeMissionStatus: null,
    participantCount: projects.length,
    unreadCompletionAt: null,
    agentSessions: projects.map((projectId, index) => ({
      id: `${id}-session-${index}`,
      groupId: id,
      participantId: `${id}-participant-${index}`,
      projectId,
      title: `Agent ${index + 1}`,
      activeRunStatus: null,
      lastEventSeq: 0,
      unreadCompletionAt: null,
      createdAt: 1,
      updatedAt: 1
    }))
  }
}

describe('groupAgentSessionsByProject', () => {
  it('projects active group sessions into their owning projects only', () => {
    const grouped = groupAgentSessionsByProject([
      group('active-a', 'active', ['project-a', 'project-b']),
      group('active-b', 'active', ['project-a']),
      group('archived', 'archived', ['project-a'])
    ])

    expect(grouped.get('project-a')?.map(({ session }) => session.id)).toEqual([
      'active-a-session-0',
      'active-b-session-0'
    ])
    expect(grouped.get('project-b')?.map(({ session }) => session.id)).toEqual([
      'active-a-session-1'
    ])
  })
})
