import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { ConversationCompactionStore } from './conversationCompactionStore'

const compactionMetadata = {
  strategy: 'model' as const,
  promptVersion: 'test-v1',
  provider: 'ollama',
  model: 'test-model'
}

describe('ConversationCompactionStore', () => {
  let db: Database.Database
  let store: ConversationCompactionStore

  beforeEach(() => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    db.prepare(
      'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run('conversation-1', 'Test', 1, 1)
    store = new ConversationCompactionStore(db)
  })

  afterEach(() => db.close())

  it('stores an anchored summary without deleting transcript messages', () => {
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, timestamp)
       VALUES (?, ?, ?, ?, ?)`
    ).run('message-1', 'conversation-1', 'user', 'Keep this forever', 10)

    const saved = store.save({
      conversationId: 'conversation-1',
      summary: 'The user asked to preserve the transcript.',
      compactedThroughMessageId: 'message-1',
      compactedThroughTimestamp: 10,
      originalTokens: 100,
      summaryTokens: 20,
      messagesCompacted: 1,
      ...compactionMetadata
    })

    expect(store.latest('conversation-1')).toEqual(saved)
    expect(db.prepare('SELECT content FROM messages WHERE id = ?').get('message-1')).toEqual({
      content: 'Keep this forever'
    })
  })

  it('invalidates summaries whose anchors were edited or rewound', () => {
    store.save({
      conversationId: 'conversation-1',
      summary: 'First summary',
      compactedThroughTimestamp: 10,
      originalTokens: 100,
      summaryTokens: 20,
      messagesCompacted: 2,
      ...compactionMetadata
    })
    store.save({
      conversationId: 'conversation-1',
      summary: 'Second summary',
      compactedThroughTimestamp: 20,
      originalTokens: 160,
      summaryTokens: 25,
      messagesCompacted: 4,
      ...compactionMetadata
    })

    expect(store.invalidateAfterTimestamp('conversation-1', 10)).toBe(1)
    expect(store.latest('conversation-1')?.summary).toBe('First summary')
    expect(store.invalidateFromTimestamp('conversation-1', 10)).toBe(1)
    expect(store.latest('conversation-1')).toBeNull()
  })

  it('copies the latest valid summary and remaps its message anchor for a fork', () => {
    db.prepare(
      'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run('conversation-2', 'Fork', 2, 2)
    store.save({
      conversationId: 'conversation-1',
      summary: 'Fork-safe summary',
      compactedThroughMessageId: 'source-message',
      compactedThroughTimestamp: 15,
      originalTokens: 120,
      summaryTokens: 24,
      messagesCompacted: 3,
      ...compactionMetadata
    })

    const copied = store.copyLatestForFork(
      'conversation-1',
      'conversation-2',
      new Map([['source-message', 'fork-message']]),
      15
    )

    expect(copied).toMatchObject({
      conversationId: 'conversation-2',
      summary: 'Fork-safe summary',
      compactedThroughMessageId: 'fork-message',
      compactedThroughTimestamp: 15,
      previousCompactionId: null
    })
  })
})
