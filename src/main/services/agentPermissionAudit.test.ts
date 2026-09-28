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

  it('records which answer the user gave and when a chat grant covered a request', () => {
    for (const [id, decision] of [
      ['permission-once', 'allow_once'],
      ['permission-chat', 'allow_chat'],
      ['permission-stop', 'deny_stop']
    ] as const) {
      store.createInteraction({
        id,
        runId: 'run-1',
        kind: 'permission',
        request: { toolCallId: id, name: 'shell', title: id, requestedAccess: 'confirm' }
      })
      store.resolveInteraction(id, { approved: decision !== 'deny_stop', decision })
    }
    store.appendEvent({
      id: 'permission-granted',
      runId: 'run-1',
      type: 'permission.resolved',
      payload: {
        toolCallId: 'command-4',
        name: 'shell',
        title: 'Run tests again',
        requestedAccess: 'confirm',
        effectiveAccess: 'confirm',
        approved: true,
        source: 'chat_grant',
        decision: 'chat_grant'
      }
    })

    const records = new Map(listAgentPermissionAudit(db).map((record) => [record.title, record]))
    expect(records.get('permission-once')).toMatchObject({
      outcome: 'user-approved',
      decision: 'allow_once'
    })
    expect(records.get('permission-chat')).toMatchObject({
      outcome: 'user-approved',
      decision: 'allow_chat'
    })
    expect(records.get('permission-stop')).toMatchObject({
      outcome: 'denied',
      decision: 'deny_stop'
    })
    expect(records.get('Run tests again')).toMatchObject({
      outcome: 'auto-approved',
      decision: 'chat_grant',
      reason: 'Allowed for this chat earlier'
    })
  })
})
