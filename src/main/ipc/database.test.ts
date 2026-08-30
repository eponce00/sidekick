import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'

type RegisteredHandler = (...args: unknown[]) => unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, RegisteredHandler>(),
  db: null as Database.Database | null
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:\\sidekick-test') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: RegisteredHandler) => {
      mocks.handlers.set(channel, handler)
    })
  }
}))

vi.mock('./state', () => ({ getDb: () => mocks.db }))
vi.mock('./workspaceUtils', () => ({ resolveKnownWorkspace: vi.fn() }))

import { registerDatabaseHandlers } from './database'

describe('conversation fork IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.db = new Database(':memory:')
    applyDatabaseSchema(mocks.db)
    registerDatabaseHandlers()
  })

  afterEach(() => {
    mocks.db?.close()
    mocks.db = null
  })

  it('forks through the exact selected message even when timestamps collide', async () => {
    const now = Date.now()
    mocks
      .db!.prepare(
        `INSERT INTO conversations
       (id, title, created_at, updated_at, project_id, title_source, title_version,
        sidebar_order, project_context_version)
       VALUES ('source', 'Source chat', ?, ?, NULL, 'user', 1, 0, 0)`
      )
      .run(now, now)
    const insert = mocks.db!.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, timestamp)
       VALUES (?, 'source', ?, ?, ?)`
    )
    insert.run('first', 'user', 'Keep this message', now)
    insert.run('second', 'agent', 'Do not copy this later message', now)

    const handler = mocks.handlers.get('conversations:fork') as RegisteredHandler
    const forked = (await handler(
      {},
      { sourceId: 'source', messageId: 'first', workspaceMode: 'current' }
    )) as { id: string; forked_from_message_id: string }

    expect(forked.forked_from_message_id).toBe('first')
    expect(
      mocks
        .db!.prepare('SELECT content FROM messages WHERE conversation_id = ? ORDER BY rowid')
        .all(forked.id)
    ).toEqual([{ content: 'Keep this message' }])
    expect(
      mocks
        .db!.prepare(
          'SELECT forked_from_conversation_id, forked_from_message_id FROM conversations WHERE id = ?'
        )
        .get(forked.id)
    ).toEqual({ forked_from_conversation_id: 'source', forked_from_message_id: 'first' })
  })

  it('pins a chat and lists it ahead of unpinned chats', async () => {
    const insert = mocks.db!.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, sidebar_order)
       VALUES (?, ?, ?, ?, ?)`
    )
    insert.run('older', 'Older chat', 1, 1, 1)
    insert.run('newer', 'Newer chat', 2, 2, 0)

    const setPinned = mocks.handlers.get('conversations:setPinned') as RegisteredHandler
    await setPinned({}, 'older', true)
    const list = mocks.handlers.get('conversations:list') as RegisteredHandler
    const conversations = (await list({})) as Array<{ id: string; is_pinned: number }>

    expect(conversations.map(({ id }) => id)).toEqual(['older', 'newer'])
    expect(conversations[0].is_pinned).toBe(1)
  })

  it('persists typed file and folder references separately from visible message text', async () => {
    mocks
      .db!.prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at)
         VALUES ('conversation', 'Attachments', 1, 1)`
      )
      .run()
    const attachment = {
      id: 'attachment-1',
      kind: 'folder',
      name: 'src',
      relativePath: 'src'
    }
    const save = mocks.handlers.get('conversations:saveMessage') as RegisteredHandler
    await save(
      {},
      {
        id: 'message',
        conversation_id: 'conversation',
        role: 'user',
        content: 'Review this folder',
        attachments: [attachment],
        timestamp: 2
      }
    )

    const getMessages = mocks.handlers.get('conversations:getMessages') as RegisteredHandler
    const messages = (await getMessages({}, 'conversation')) as Array<{
      content: string
      attachments: unknown[]
    }>
    expect(messages[0]).toMatchObject({
      content: 'Review this folder',
      attachments: [attachment]
    })
  })
})
