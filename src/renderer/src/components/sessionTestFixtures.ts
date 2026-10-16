import type {
  SessionFamilyMember,
  SessionMessage,
  SessionState,
  SessionStatus
} from '../../../shared/sessions'

/** Family members and messages for component tests. */
export function familyMember(
  handle: string | null,
  overrides: Partial<SessionFamilyMember> = {}
): SessionFamilyMember {
  return {
    conversationId: handle ? `worker-${handle}` : 'manager',
    startedByKind: handle ? 'session' : 'user',
    startedByConversationId: handle ? 'manager' : null,
    reportToConversationId: handle ? 'manager' : null,
    handle,
    workIn: handle ? 'worktree' : null,
    archivedAt: null,
    title: handle ? `Task for ${handle}` : 'Design review',
    projectId: handle ? `project-${handle}` : 'project-demo',
    projectName: handle ? `sidekick-demo · sidekick/${handle}` : 'sidekick-demo',
    state: 'idle',
    ...overrides
  }
}

export function familyMessage(
  id: string,
  from: string | null,
  to: string,
  intent: SessionMessage['intent'],
  body = id
): SessionMessage {
  return {
    id,
    fromConversationId: from,
    toConversationId: to,
    intent,
    body,
    attachments: [],
    replyToMessageId: null,
    createdAt: 1,
    deliveredRunId: null,
    deliveredAt: null,
    readAt: null
  }
}

export function statusMap(
  entries: Array<[string, SessionState, string?]>
): Map<string, SessionStatus> {
  return new Map(
    entries.map(([conversationId, state, reason]) => [
      conversationId,
      { conversationId, state, since: 0, ...(reason ? { reason } : {}) }
    ])
  )
}
