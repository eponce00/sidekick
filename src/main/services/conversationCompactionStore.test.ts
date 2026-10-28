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

  it('keeps how far into the reply after its anchor a summary reached, through a fork', () => {
    db.prepare(
      'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run('conversation-2', 'Fork', 2, 2)
    const plain = store.save({
      conversationId: 'conversation-1',
      summary: 'Earlier turns',
      compactedThroughMessageId: 'request',
      originalTokens: 120,
      summaryTokens: 24,
      messagesCompacted: 3,
      ...compactionMetadata
    })
    expect(plain).toMatchObject({ replyMessageId: null, replyMessagesCovered: 0 })
    store.save({
      conversationId: 'conversation-1',
      summary: 'Earlier turns and most of the reply',
      compactedThroughMessageId: 'request',
      compactedThroughTimestamp: 20,
      originalTokens: 120,
      summaryTokens: 24,
      messagesCompacted: 9,
      replyMessageId: 'reply',
      replyMessagesCovered: 6,
      ...compactionMetadata
    })

    expect(
      store.copyLatestForFork(
        'conversation-1',
        'conversation-2',
        new Map([
          ['request', 'fork-request'],
          ['reply', 'fork-reply']
        ]),
        20
      )
    ).toMatchObject({
      compactedThroughMessageId: 'fork-request',
      replyMessageId: 'fork-reply',
      replyMessagesCovered: 6,
      previousCompactionId: null
    })
  })
})
