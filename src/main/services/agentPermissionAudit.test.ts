import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { listAgentPermissionAudit } from './agentPermissionAudit'
import { AgentRunStore } from './agentRunStore'

describe('agent permission audit projection', () => {
  let db: Database.Database
  let store: AgentRunStore

  beforeEach(() => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    store = new AgentRunStore(db)
    store.start({
      id: 'run-1',
      threadId: 'thread-1',
      profile: { surface: 'conversation', executionMode: 'act', capabilities: ['workspace.write'] },
      provider: 'test',
      model: 'test',
      workspaceRoot: '/workspace'
    })
  })

  it('projects policy approvals directly from the event ledger', () => {
    store.appendEvent({
      id: 'permission-auto',
      runId: 'run-1',
      type: 'permission.resolved',
      payload: {
        toolCallId: 'write-1',
        name: 'write',
        title: 'Write report.md',
        requestedAccess: 'auto',
        effectiveAccess: 'auto',
        mode: 'full-access',
        approved: true,
        arguments: { file_path: 'report.md' }
      }
    })

    expect(listAgentPermissionAudit(db)).toEqual([
      expect.objectContaining({
        id: 'agent:permission-auto',
        operationKind: 'workspace',
        title: 'Write report.md',
        mode: 'full-access',
        outcome: 'auto-approved'
      })
    ])
  })

  it('joins durable interaction requests with user decisions', () => {
    store.createInteraction({
      id: 'permission-1',
      runId: 'run-1',
      kind: 'permission',
      request: {
        toolCallId: 'command-1',
        name: 'shell',
        title: 'Install dependencies',
        requestedAccess: 'confirm',
        mode: 'always-ask',
        arguments: { command: 'npm install' }
      }
    })
    store.resolveInteraction('permission-1', { approved: false })

    expect(listAgentPermissionAudit(db)[0]).toMatchObject({
      operationKind: 'command',
      title: 'Install dependencies',
      requestedAccess: 'confirm',
      effectiveAccess: 'confirm',
      mode: 'always-ask',
      outcome: 'denied'
    })
  })
})
