import { describe, expect, it } from 'vitest'
import type { ProjectConversation } from './projects'
import {
  SESSION_LIMITS,
  mostUrgentSessionState,
  sessionHandleProblem,
  sessionLinkFromConversation,
  suggestSessionHandle
} from './sessions'

describe('session states', () => {
  it('rolls a family up to its most urgent state', () => {
    expect(mostUrgentSessionState(['done', 'working', 'waiting'])).toBe('waiting')
    expect(mostUrgentSessionState(['done', 'failed', 'working'])).toBe('failed')
    expect(mostUrgentSessionState(['idle', 'queued', 'done'])).toBe('queued')
    expect(mostUrgentSessionState(['stopped', 'done'])).toBe('done')
    expect(mostUrgentSessionState([])).toBe('idle')
  })
})

describe('session handles', () => {
  it('accepts lowercase words joined by single dashes', () => {
    expect(sessionHandleProblem('api-contract')).toBeNull()
    expect(sessionHandleProblem('s3')).toBeNull()
  })

  it('rejects empty, malformed, overlong and reserved handles', () => {
    expect(sessionHandleProblem('')).not.toBeNull()
    expect(sessionHandleProblem('Api')).not.toBeNull()
    expect(sessionHandleProblem('api--contract')).not.toBeNull()
    expect(sessionHandleProblem('-api')).not.toBeNull()
    expect(sessionHandleProblem('a'.repeat(SESSION_LIMITS.handleMaxLength + 1))).not.toBeNull()
    expect(sessionHandleProblem('manager')).not.toBeNull()
    expect(sessionHandleProblem('family')).not.toBeNull()
  })

  it('derives a valid, free handle from a title', () => {
    expect(suggestSessionHandle("Port Cline's schedules")).toBe('port-cline-s-schedules')
    expect(suggestSessionHandle('Schedules', ['schedules'])).toBe('schedules-2')
    expect(suggestSessionHandle('Schedules', ['schedules', 'schedules-2'])).toBe('schedules-3')
    expect(suggestSessionHandle('!!!')).toBe('chat')
    expect(suggestSessionHandle('Manager')).toBe('manager-chat')
    const long = suggestSessionHandle('x'.repeat(80), ['x'.repeat(29)])
    expect(sessionHandleProblem(long)).toBeNull()
  })
})

describe('session links', () => {
  const base: ProjectConversation = {
    id: 'worker',
    title: 'Worker',
    created_at: 0,
    updated_at: 0,
    project_id: null,
    sidebar_order: 0,
    project_context_version: 0,
    home_workspace_root: null,
    home_project_name: null
  }

  it('reads a chat from before families as one the user started', () => {
    expect(sessionLinkFromConversation(base)).toEqual({
      conversationId: 'worker',
      startedByKind: 'user',
      startedByConversationId: null,
      reportToConversationId: null,
      handle: null,
      workIn: null,
      archivedAt: null
    })
  })

  it('reads a worker and ignores unknown stored values', () => {
    expect(
      sessionLinkFromConversation({
        ...base,
        started_by_kind: 'session',
        started_by_conversation_id: 'manager',
        report_to_conversation_id: 'manager',
        session_handle: 'worker',
        work_in: 'worktree',
        archived_at: 5
      })
    ).toMatchObject({
      startedByKind: 'session',
      handle: 'worker',
      workIn: 'worktree',
      archivedAt: 5
    })
    expect(
      sessionLinkFromConversation({
        ...base,
        started_by_kind: 'robot' as never,
        work_in: 'cloud' as never
      })
    ).toMatchObject({ startedByKind: 'user', workIn: null })
  })
})
