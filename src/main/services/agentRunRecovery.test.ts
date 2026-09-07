import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { openApplicationDatabase } from '../bootstrap/database'
import { AgentRunStore } from './agentRunStore'
import { recoverAgentRunMaterializations } from './agentRunRecovery'

describe('durable run finalization recovery', () => {
  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    'does not resurrect deleted conversations while finalizing an orphaned %s journal',
    (phase) => {
      const db = openApplicationDatabase(':memory:')
      try {
        const store = new AgentRunStore(db)
        store.start({
          id: 'orphan',
          threadId: 'deleted-thread',
          outputMessageId: 'deleted-message',
          profile: { surface: 'conversation', executionMode: 'act', capabilities: [] },
          provider: 'fixture',
          model: 'fixture'
        })
        store.transition('orphan', phase, 'orphan:terminal')
        const restore = vi.fn()
        recoverAgentRunMaterializations(db, store, restore)
        expect(restore).not.toHaveBeenCalled()
        expect(db.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 0 })
        expect(store.listAllEvents('orphan').at(-1)?.payload).toMatchObject({
          persisted: false,
          recovered: true
        })
        expect(store.get('orphan')?.phase).toBe(phase)
        const events = store.listAllEvents('orphan')
        recoverAgentRunMaterializations(db, store, restore)
        expect(store.listAllEvents('orphan')).toEqual(events)
      } finally {
        db.close()
      }
    }
  )

  it('retries interrupted recovery atomically and finalizes already-terminal journals after reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-finalize-fault-'))
    let db: Database.Database | undefined
    try {
      const path = join(root, 'app.db')
      db = openApplicationDatabase(path)
      db.exec(
        "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('thread', 'Fixture', 1, 1)"
      )
      let store = new AgentRunStore(db)
      for (const id of ['active', 'terminal']) {
        store.start({
          id,
          threadId: 'thread',
          outputMessageId: `message-${id}`,
          profile: { surface: 'conversation', executionMode: 'act', capabilities: [] },
          provider: 'fixture',
          model: 'fixture'
        })
        store.appendEvent({
          id: `${id}:delta`,
          runId: id,
          type: 'assistant.delta',
          payload: { content: `Recovered ${id}` }
        })
      }
      store.transition('terminal', 'completed', 'terminal:completed')
      // Simulate the existing message having been persisted before finalization.
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, timestamp,
        checkpoint_hash, checkpoint_workspace_root) VALUES (?, 'thread', 'agent', 'Partial', 1, 'fixture-hash', '/fixture')`
      ).run('message-terminal')
      db.close()
      db = openApplicationDatabase(path)
      store = new AgentRunStore(db)
      const originalEvents = store.listAllEvents('active')
      const injected = vi.fn(() => {
        if (injected.mock.calls.length === 2) throw new Error('injected recovery failure')
      })
      expect(() => recoverAgentRunMaterializations(db!, store, injected)).toThrow(
        'injected recovery failure'
      )
      expect(store.get('active')?.phase).toBe('queued')
      expect(store.listAllEvents('active')).toEqual(originalEvents)
      expect(
        db.prepare("SELECT id FROM messages WHERE id = 'message-active'").get()
      ).toBeUndefined()
      db.close()
      db = openApplicationDatabase(path)
      store = new AgentRunStore(db)
      const restore = vi.fn()
      recoverAgentRunMaterializations(db, store, restore)
      expect(restore).toHaveBeenCalledTimes(2)
      expect(store.get('active')?.phase).toBe('interrupted')
      expect(store.get('terminal')?.phase).toBe('completed')
      expect(
        db
          .prepare("SELECT content, checkpoint_hash FROM messages WHERE id = 'message-terminal'")
          .get()
      ).toEqual({ content: 'Recovered terminal', checkpoint_hash: 'fixture-hash' })
      expect(db.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 2 })
      for (const id of ['active', 'terminal'])
        expect(
          store.listAllEvents(id).filter((event) => event.type === 'run.finalized')
        ).toHaveLength(1)
      recoverAgentRunMaterializations(db, store, restore)
      expect(restore).toHaveBeenCalledTimes(2)
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally {
      if (db?.open) db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
