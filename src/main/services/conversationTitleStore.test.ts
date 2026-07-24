import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { ConversationTitleStore } from './conversationTitleStore'

describe('ConversationTitleStore', () => {
  let db: Database.Database
  let now = 10_000_000
  let store: ConversationTitleStore

  beforeEach(() => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    store = new ConversationTitleStore(db, { now: () => now })
  })

  afterEach(() => db.close())

  function insertConversation(
    id: string,
    title: string,
    source: string,
    version = 0,
    updatedAt = 100
  ): void {
    db.prepare(
      `INSERT INTO conversations
       (id, title, created_at, updated_at, title_source, title_version)
       VALUES (?, ?, 1, ?, ?, ?)`
    ).run(id, title, updatedAt, source, version)
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, timestamp)
       VALUES (?, ?, 'user', ?, 2)`
    ).run(`${id}-user`, id, `Question for ${id}`)
  }

  it('returns only eligible rows with small conversation excerpts', () => {
    insertConversation('fallback', 'Question for fallback', 'fallback', 0, 300)
    insertConversation('manual', 'My chosen title', 'user', 1, 400)
    insertConversation('generated', 'Generated title', 'generated', 1, 500)
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, timestamp)
       VALUES ('fallback-agent', 'fallback', 'agent', 'A useful answer', 3)`
    ).run()

    expect(store.listCandidates()).toEqual([
      expect.objectContaining({
        id: 'fallback',
        titleSource: 'fallback',
        firstUserMessage: 'Question for fallback',
        firstAssistantMessage: 'A useful answer'
      })
    ])
  })

  it('claims work atomically and respects the retry interval', () => {
    insertConversation('fallback', 'Question for fallback', 'fallback')
    const identity = { id: 'fallback', expectedTitle: 'Question for fallback' }

    expect(store.claim(identity)).toBe(true)
    expect(store.claim(identity)).toBe(false)
    expect(store.listCandidates()).toHaveLength(0)

    now += 6 * 60 * 60 * 1000 + 1
    expect(store.claim(identity)).toBe(true)
  })

  it('can revisit SideKick-generated titles after a future prompt-version upgrade', () => {
    insertConversation('generated-old', 'Older generated title', 'generated', 0)

    expect(store.listCandidates()).toEqual([
      expect.objectContaining({ id: 'generated-old', titleSource: 'generated', titleVersion: 0 })
    ])
  })

  it('does not overwrite a title changed after the worker claimed it', () => {
    insertConversation('fallback', 'Question for fallback', 'fallback')
    const identity = { id: 'fallback', expectedTitle: 'Question for fallback' }
    expect(store.claim(identity)).toBe(true)
    db.prepare(
      `UPDATE conversations
       SET title = 'Manual name', title_source = 'user', title_version = 1
       WHERE id = 'fallback'`
    ).run()

    expect(store.complete({ ...identity, title: 'Generated name' })).toBe(false)
    expect(
      db.prepare('SELECT title, title_source FROM conversations WHERE id = ?').get('fallback')
    ).toEqual({ title: 'Manual name', title_source: 'user' })
  })

  it('completes without changing conversation activity order', () => {
    insertConversation('fallback', 'Question for fallback', 'fallback', 0, 1234)
    const identity = { id: 'fallback', expectedTitle: 'Question for fallback' }

    expect(store.claim(identity)).toBe(true)
    expect(store.complete({ ...identity, title: 'Focused generated title' })).toBe(true)
    expect(
      db
        .prepare(
          `SELECT title, title_source, title_version, updated_at
           FROM conversations WHERE id = 'fallback'`
        )
        .get()
    ).toEqual({
      title: 'Focused generated title',
      title_source: 'generated',
      title_version: 1,
      updated_at: 1234
    })
  })

  it('marks ambiguous legacy titles as preserved', () => {
    insertConversation('legacy', 'A title we cannot safely classify', 'legacy')

    expect(
      store.preserve({ id: 'legacy', expectedTitle: 'A title we cannot safely classify' })
    ).toBe(true)
    expect(store.listCandidates()).toHaveLength(0)
  })
})
