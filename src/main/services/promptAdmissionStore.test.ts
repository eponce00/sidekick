import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { PromptAdmissionStore } from './promptAdmissionStore'

describe('PromptAdmissionStore', () => {
  let db: Database.Database
  let store: PromptAdmissionStore

  beforeEach(() => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    db.prepare(
      'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run('conversation-1', 'Test', 1, 1)
    store = new PromptAdmissionStore(db)
  })

  afterEach(() => db.close())

  it('persists ordering and atomically admits a pivot before queued prompts', () => {
    store.replace({
      conversationId: 'conversation-1',
      pivot: { id: 'pivot', content: 'steer', mode: 'conversation' },
      queued: [
        { id: 'first', content: 'one', mode: 'research' },
        { id: 'second', content: 'two', mode: 'plan' }
      ]
    })

    expect(store.takeNext('conversation-1')).toMatchObject({ id: 'pivot', behavior: 'pivot' })
    expect(store.takeNext('conversation-1')).toMatchObject({ id: 'first', behavior: 'queue' })
    expect(store.takeNext('conversation-1')).toMatchObject({ id: 'second', behavior: 'queue' })
    expect(store.takeNext('conversation-1')).toBeNull()
  })

  it('replaces a renderer snapshot without resetting original creation time', () => {
    const first = store.replace({
      conversationId: 'conversation-1',
      pivot: null,
      queued: [{ id: 'message', content: 'before', mode: 'conversation' }]
    }).queued[0]
    const second = store.replace({
      conversationId: 'conversation-1',
      pivot: null,
      queued: [{ id: 'message', content: 'after', mode: 'research' }]
    }).queued[0]

    expect(second).toMatchObject({ id: 'message', content: 'after', mode: 'research' })
    expect(second.createdAt).toBe(first.createdAt)
  })

  it('keeps file and folder references with a queued prompt', () => {
    const attachment = {
      id: 'attachment-1',
      kind: 'folder' as const,
      name: 'src',
      relativePath: 'src'
    }
    store.replace({
      conversationId: 'conversation-1',
      pivot: null,
      queued: [
        { id: 'message', content: 'review', attachments: [attachment], mode: 'conversation' }
      ]
    })

    expect(store.takeNext('conversation-1')?.attachments).toEqual([attachment])
  })
})
