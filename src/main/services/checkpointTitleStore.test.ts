import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { CheckpointTitleStore } from './checkpointTitleStore'

describe('CheckpointTitleStore', () => {
  let db: Database.Database
  const now = 10_000_000
  let store: CheckpointTitleStore
  const workspaceRoot = '/workspace/project'
  const hash = 'a'.repeat(40)
  const rawCheckpoint = {
    hash,
    message: 'Sure, let me rebuild the whole page with a much nicer design',
    timestamp: 9_000_000,
    workspaceRoot
  }

  beforeEach(() => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    store = new CheckpointTitleStore(db, { now: () => now })
  })

  afterEach(() => db.close())

  it('overlays mutable labels while keeping the stable checkpoint hash', () => {
    expect(store.sync(workspaceRoot, [rawCheckpoint])).toEqual([
      expect.objectContaining({ hash, message: rawCheckpoint.message, titleSource: 'legacy' })
    ])

    expect(store.updateLabel(workspaceRoot, hash, 'Refine landing page design', 'generated')).toBe(
      true
    )
    expect(store.sync(workspaceRoot, [rawCheckpoint])).toEqual([
      expect.objectContaining({
        hash,
        message: 'Refine landing page design',
        titleSource: 'generated',
        titleVersion: 1
      })
    ])
  })

  it('claims and completes legacy labels atomically without accepting stale titles', () => {
    store.sync(workspaceRoot, [rawCheckpoint])
    const identity = { workspaceRoot, hash, expectedTitle: rawCheckpoint.message }

    expect(store.claim(identity)).toBe(true)
    expect(store.claim(identity)).toBe(false)
    expect(store.complete({ ...identity, title: 'Modernize landing page' })).toBe(true)
    expect(store.complete({ ...identity, title: 'Overwrite newer title' })).toBe(false)
    expect(store.sync(workspaceRoot, [rawCheckpoint])[0].message).toBe('Modernize landing page')
  })

  it('recovers the nearest project conversation context for old unlinked checkpoints', () => {
    db.prepare(
      `INSERT INTO projects (id, name, folder_path, created_at, updated_at)
       VALUES ('project-1', 'Project', ?, 1, 1)`
    ).run(workspaceRoot)
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, project_id)
       VALUES ('conversation-1', 'Landing page', 1, 1, 'project-1')`
    ).run()
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, timestamp)
       VALUES ('user-1', 'conversation-1', 'user', 'Improve the landing page styling', ?)`
    ).run(rawCheckpoint.timestamp - 2_000)
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, timestamp)
       VALUES ('agent-1', 'conversation-1', 'agent', 'Updated the layout and animations', ?)`
    ).run(rawCheckpoint.timestamp + 500)

    expect(store.findContext(workspaceRoot, hash, rawCheckpoint.timestamp)).toEqual({
      userContent: 'Improve the landing page styling',
      assistantContent: 'Updated the layout and animations'
    })
  })

  it('prefers an exact persisted checkpoint link over timestamp proximity', () => {
    db.prepare(
      `INSERT INTO projects (id, name, folder_path, created_at, updated_at)
       VALUES ('project-1', 'Project', ?, 1, 1)`
    ).run(workspaceRoot)
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, project_id)
       VALUES ('conversation-1', 'Landing page', 1, 1, 'project-1')`
    ).run()
    db.prepare(
      `INSERT INTO messages
       (id, conversation_id, role, content, checkpoint_hash, timestamp)
       VALUES ('linked-agent', 'conversation-1', 'agent', 'Exact linked response', ?, ?)`
    ).run(hash, rawCheckpoint.timestamp + 30_000)
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, timestamp)
       VALUES ('near-agent', 'conversation-1', 'agent', 'Closer but unlinked response', ?)`
    ).run(rawCheckpoint.timestamp)

    expect(store.findContext(workspaceRoot, hash, rawCheckpoint.timestamp)?.assistantContent).toBe(
      'Exact linked response'
    )
  })
})
