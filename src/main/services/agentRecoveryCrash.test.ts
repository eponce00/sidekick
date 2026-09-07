import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { openApplicationDatabase } from '../bootstrap/database'
import { AgentRunStore } from './agentRunStore'
import { recoverAgentRunMaterializations } from './agentRunRecovery'

it.each(['migration', 'recovery'] as const)(
  'rolls back a killed %s transaction and retries without duplicate state',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-transaction-kill-'))
    let db: Database.Database | undefined
    let child: ReturnType<typeof spawn> | undefined
    try {
      const path = join(root, 'state.db')
      db = openApplicationDatabase(path)
      db.exec(
        "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('fixture-thread', 'Keep me', 1, 1)"
      )
      if (mode === 'migration') {
        db.exec(`
        CREATE TABLE conversation_runs (id TEXT PRIMARY KEY);
        INSERT INTO conversation_runs VALUES ('legacy-fixture');
        DELETE FROM schema_migrations WHERE id IN ('20260829_001_canonical_runtime', '20260829_003_journal_materializations');
        DROP INDEX idx_messages_run_materialization;
        CREATE TRIGGER fixture_migration_boundary AFTER INSERT ON schema_migrations
          WHEN NEW.id = '20260829_003_journal_materializations'
          BEGIN SELECT hold_migration((SELECT count(*) FROM sqlite_master WHERE name = 'conversation_runs')); END;
      `)
      } else {
        const store = new AgentRunStore(db)
        for (const id of ['first', 'second']) {
          store.start({
            id,
            threadId: 'fixture-thread',
            outputMessageId: `message-${id}`,
            profile: { surface: 'conversation', executionMode: 'act', capabilities: [] },
            provider: 'fixture',
            model: 'fixture'
          })
          store.appendEvent({
            id: `${id}:delta`,
            runId: id,
            type: 'assistant.delta',
            payload: { content: `Partial ${id}` }
          })
          store.appendEvent({
            id: `${id}:tool`,
            runId: id,
            type: 'tool.running',
            payload: { toolCallId: `unknown-${id}`, name: 'shell' }
          })
        }
      }
      const schemaBefore = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()
      const ledgerBefore = db.prepare('SELECT * FROM schema_migrations ORDER BY id').all()
      const eventsBefore = db.prepare('SELECT * FROM agent_run_events ORDER BY id').all()
      db.close()
      const script = join(root, 'crash-transaction.cjs')
      await build({
        entryPoints: [resolve('src/main/services/fixtures/crashRecoveryTransaction.ts')],
        outfile: script,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        packages: 'external'
      })
      child = spawn(process.execPath, [script, path, mode], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ELECTRON_RUN_AS_NODE: '1',
          NODE_PATH: resolve('node_modules')
        }
      })
      const closed = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
      let errorOutput = ''
      child.stderr?.on('data', (data) => {
        errorOutput += String(data)
      })
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`No transaction boundary: ${errorOutput}`)),
          10_000
        )
        child!.once('message', (message) => {
          clearTimeout(timeout)
          if (JSON.stringify(message) !== JSON.stringify({ boundary: mode, inTransaction: true }))
            reject(new Error('Invalid transaction boundary'))
          else resolve()
        })
        child!.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        child!.once('exit', (code) => {
          clearTimeout(timeout)
          reject(new Error(`Early fixture exit ${code}: ${errorOutput}`))
        })
      })
      expect(child.kill('SIGKILL')).toBe(true)
      await closed
      db = new Database(path)
      expect(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(schemaBefore)
      expect(db.prepare('SELECT * FROM schema_migrations ORDER BY id').all()).toEqual(ledgerBefore)
      expect(db.prepare('SELECT * FROM agent_run_events ORDER BY id').all()).toEqual(eventsBefore)
      expect(db.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 0 })
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
      if (mode === 'migration') {
        expect(db.prepare('SELECT * FROM conversation_runs').all()).toEqual([
          { id: 'legacy-fixture' }
        ])
        db.exec('DROP TRIGGER fixture_migration_boundary')
      }
      db.close()
      db = openApplicationDatabase(path)
      const store = new AgentRunStore(db)
      recoverAgentRunMaterializations(db, store, () => undefined)
      if (mode === 'recovery') {
        expect(db.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 2 })
        for (const id of ['first', 'second']) {
          expect(store.get(id)?.phase).toBe('interrupted')
          expect(
            store.listAllEvents(id).filter((event) => event.type === 'tool.completed')
          ).toHaveLength(1)
          expect(
            store.listAllEvents(id).filter((event) => event.type === 'run.finalized')
          ).toHaveLength(1)
        }
      } else {
        expect(db.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({
          count: 7
        })
        expect(
          db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'conversation_runs'").get()
        ).toBeUndefined()
      }
      const recoveredEvents = db.prepare('SELECT * FROM agent_run_events ORDER BY id').all()
      recoverAgentRunMaterializations(db, store, () => undefined)
      expect(db.prepare('SELECT * FROM agent_run_events ORDER BY id').all()).toEqual(
        recoveredEvents
      )
      expect(db.prepare('SELECT title FROM conversations').get()).toEqual({ title: 'Keep me' })
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
        child.kill('SIGKILL')
        await closed
      }
      if (db?.open) db.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  20_000
)
