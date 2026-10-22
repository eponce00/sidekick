import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'

type RegisteredHandler = (...args: unknown[]) => unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, RegisteredHandler>(),
  db: null as Database.Database | null,
  createWorktree: vi.fn(),
  discardFresh: vi.fn(),
  discardWithUnusedChat: vi.fn(),
  setupCreatedWorktree: vi.fn()
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
vi.mock('./worktrees', () => ({
  getManagedWorktrees: () => ({
    create: mocks.createWorktree,
    discardFresh: mocks.discardFresh,
    discardWithUnusedChat: mocks.discardWithUnusedChat,
    worktreeIdFor: () => null
  })
}))
vi.mock('./worktreeSetup', () => ({ setupCreatedWorktree: mocks.setupCreatedWorktree }))

import { registerDatabaseHandlers } from './database'

describe('conversation fork IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.createWorktree.mockReset()
    mocks.discardFresh.mockReset()
    mocks.setupCreatedWorktree.mockReset()
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

  it('refuses to edit a message that belongs to a different conversation', async () => {
    const insertConversation = mocks.db!.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, sidebar_order)
       VALUES (?, ?, 1, 1, 0)`
    )
    insertConversation.run('mine', 'My chat')
    insertConversation.run('theirs', 'Their chat')
    mocks
      .db!.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, timestamp)
         VALUES ('target', 'theirs', 'user', 'Original content', 5)`
      )
      .run()

    const updateMessage = mocks.handlers.get('conversations:updateMessage') as RegisteredHandler
    await expect(
      updateMessage(
        {},
        { id: 'target', conversation_id: 'mine', content: 'Hijacked', timestamp: 5 }
      )
    ).rejects.toThrow('Message not found in conversation')

    expect(mocks.db!.prepare('SELECT content FROM messages WHERE id = ?').get('target')).toEqual({
      content: 'Original content'
    })
  })

  it('starts a new chat on the model it is given, and a fork on its source chat’s model', async () => {
    const create = mocks.handlers.get('conversations:create') as RegisteredHandler
    const created = (await create(
      {},
      'New Conversation',
      null,
      'placeholder',
      'ollama:ollama-local/qwen3:8b'
    )) as { id: string; model_id: string | null }
    const withoutModel = (await create({}, 'New Conversation', null, 'placeholder', 42)) as {
      id: string
      model_id: string | null
    }
    const modelOf = (id: string): unknown =>
      (
        mocks.db!.prepare('SELECT model_id FROM conversations WHERE id = ?').get(id) as {
          model_id: string | null
        }
      ).model_id

    expect(created.model_id).toBe('ollama:ollama-local/qwen3:8b')
    expect(modelOf(created.id)).toBe('ollama:ollama-local/qwen3:8b')
    // Anything that is not a model id leaves the chat on the new-chat default.
    expect(modelOf(withoutModel.id)).toBeNull()

    const fork = mocks.handlers.get('conversations:fork') as RegisteredHandler
    const forked = (await fork({}, { sourceId: created.id, workspaceMode: 'current' })) as {
      id: string
      model_id: string | null
    }
    expect(forked.model_id).toBe('ollama:ollama-local/qwen3:8b')
    expect(modelOf(forked.id)).toBe('ollama:ollama-local/qwen3:8b')
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

  it('preserves the committed fork and copied messages when worktree setup fails', async () => {
    const insertProject = mocks.db!.prepare(
      `INSERT INTO projects (id, name, folder_path, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1)`
    )
    insertProject.run('source-project', 'Source project', '/source-project')
    mocks
      .db!.prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, project_id)
       VALUES ('source', 'Source chat', 1, 1, 'source-project')`
      )
      .run()
    mocks
      .db!.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, timestamp)
       VALUES ('source-message', 'source', 'user', 'Keep this durable history', 1)`
      )
      .run()
    mocks.createWorktree.mockImplementation(async () => {
      mocks
        .db!.prepare(
          `INSERT INTO managed_worktrees
           (id, source_project_id, repository_root, worktree_root, folder_path, created_at,
            last_used_at)
           VALUES ('fork-worktree', 'source-project', '/source-project', '/fork-worktree',
                   '/fork-worktree', 1, 1)`
        )
        .run()
      return { id: 'fork-worktree', folderPath: '/fork-worktree' }
    })
    let committedForkId: string | undefined
    mocks.setupCreatedWorktree.mockImplementation(async () => {
      // The external setup boundary must only run after the transaction commits.
      expect(mocks.db!.inTransaction).toBe(false)
      const persisted = mocks
        .db!.prepare('SELECT id FROM conversations WHERE forked_from_conversation_id = ?')
        .get('source') as { id: string } | undefined
      expect(persisted).toBeDefined()
      committedForkId = persisted?.id
      expect(
        mocks
          .db!.prepare('SELECT content FROM messages WHERE conversation_id = ?')
          .all(committedForkId)
      ).toEqual([{ content: 'Keep this durable history' }])
      throw new Error('Injected setup failure after durable fork')
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const sender = { id: 42 }
      const handler = mocks.handlers.get('conversations:fork') as RegisteredHandler
      const forked = (await handler(
        { sender },
        { sourceId: 'source', workspaceMode: 'worktree' }
      )) as { id: string; project_id: string }
      // The fork stays in its project and works in its own new worktree.
      expect(forked).toMatchObject({
        id: committedForkId,
        project_id: 'source-project',
        worktree_id: 'fork-worktree',
        worktree_folder: '/fork-worktree'
      })
      expect(mocks.setupCreatedWorktree).toHaveBeenCalledWith(
        sender,
        '/source-project',
        '/fork-worktree'
      )
      expect(mocks.discardFresh).not.toHaveBeenCalled()
      expect(
        mocks.db!.prepare('SELECT worktree_id FROM conversations WHERE id = ?').get(forked.id)
      ).toEqual({ worktree_id: 'fork-worktree' })
      expect(
        mocks.db!.prepare('SELECT id FROM conversations WHERE id = ?').get(forked.id)
      ).toBeDefined()
      expect(
        mocks.db!.prepare('SELECT content FROM messages WHERE conversation_id = ?').all(forked.id)
      ).toEqual([{ content: 'Keep this durable history' }])
      expect(warning).toHaveBeenCalledWith(
        '[Worktrees] Setup could not finish; created fork preserved'
      )
    } finally {
      warning.mockRestore()
    }
  })

  it('persists typed file and folder references and pasted text separately from visible message text', async () => {
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
    const pasted = {
      id: 'paste-1',
      kind: 'text',
      name: 'Error: build failed',
      content: 'Error: build failed\n  at compile (build.ts:12)',
      size: 45
    }
    const save = mocks.handlers.get('conversations:saveMessage') as RegisteredHandler
    await save(
      {},
      {
        id: 'message',
        conversation_id: 'conversation',
        role: 'user',
        content: 'Review this folder',
        attachments: [attachment, pasted],
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
      attachments: [attachment, pasted]
    })
  })

  it('stores a large original image, and refuses images the renderer misdescribes', async () => {
    mocks
      .db!.prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at)
         VALUES ('conversation', 'Images', 1, 1)`
      )
      .run()
    const pixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    )
    // Over the old 8 MB limit; only the copy a model receives is reduced.
    const large = Buffer.concat([pixel.subarray(0, 33), Buffer.alloc(9 * 1024 * 1024)])
    const bomb = Buffer.from(pixel)
    bomb.writeUInt32BE(60_000, 16)
    bomb.writeUInt32BE(60_000, 20)
    const image = (bytes: Buffer, mimeType = 'image/png') => ({
      id: `image-${mimeType}-${bytes.length}`,
      name: 'screenshot.png',
      mimeType,
      dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`
    })
    const save = mocks.handlers.get('conversations:saveMessage') as RegisteredHandler
    const message = (id: string, images: unknown[]) => ({
      id,
      conversation_id: 'conversation',
      role: 'user',
      content: 'Look',
      images,
      timestamp: 2
    })

    await save({}, message('large', [image(large)]))
    const stored = mocks.db!.prepare("SELECT images FROM messages WHERE id = 'large'").get() as {
      images: string
    }
    expect(JSON.parse(stored.images)[0].dataUrl).toBe(image(large).dataUrl)

    for (const forged of [
      image(bomb),
      image(pixel, 'image/jpeg'),
      image(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    ]) {
      await expect(save({}, message(`forged-${forged.id}`, [forged]))).rejects.toThrow(
        'Invalid message image attachment'
      )
    }
    expect(
      mocks.db!.prepare("SELECT COUNT(*) AS count FROM messages WHERE id LIKE 'forged-%'").get()
    ).toEqual({ count: 0 })
  })

  it('keeps a notice tone across reopening, and ignores tones it does not know', async () => {
    // A finished goal is reported as a success notice. Without its tone the
    // reopened conversation showed it as an ordinary info row.
    mocks
      .db!.prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at)
         VALUES ('conversation', 'Notices', 1, 1)`
      )
      .run()
    const save = mocks.handlers.get('conversations:saveMessage') as RegisteredHandler
    await save(
      {},
      {
        id: 'goal-complete:goal-1',
        conversation_id: 'conversation',
        role: 'system',
        noticeTone: 'success',
        content: 'Goal complete',
        timestamp: 2
      }
    )
    await save(
      {},
      {
        id: 'odd',
        conversation_id: 'conversation',
        role: 'system',
        noticeTone: 'celebration',
        content: 'Unknown tone',
        timestamp: 3
      }
    )

    const getMessages = mocks.handlers.get('conversations:getMessages') as RegisteredHandler
    const messages = (await getMessages({}, 'conversation')) as Array<{
      id: string
      noticeTone?: string
    }>
    expect(messages.map(({ id, noticeTone }) => ({ id, noticeTone }))).toEqual([
      { id: 'goal-complete:goal-1', noticeTone: 'success' },
      { id: 'odd', noticeTone: undefined }
    ])
  })

  it('remembers which message a goal began from, so a retry can start it again', async () => {
    mocks
      .db!.prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at)
         VALUES ('conversation', 'Goal origin', 1, 1)`
      )
      .run()
    const save = mocks.handlers.get('conversations:saveMessage') as RegisteredHandler
    await save(
      {},
      {
        id: 'objective',
        conversation_id: 'conversation',
        role: 'user',
        content: 'Build a card',
        startsGoal: true,
        timestamp: 2
      }
    )
    await save(
      {},
      { id: 'ordinary', conversation_id: 'conversation', role: 'user', content: 'Hi', timestamp: 3 }
    )

    const getMessages = mocks.handlers.get('conversations:getMessages') as RegisteredHandler
    const messages = (await getMessages({}, 'conversation')) as Array<{
      id: string
      startsGoal?: boolean
    }>
    expect(messages.map(({ id, startsGoal }) => ({ id, startsGoal }))).toEqual([
      { id: 'objective', startsGoal: true },
      { id: 'ordinary', startsGoal: undefined }
    ])
  })
})

describe('discarding a chat left unused', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.discardWithUnusedChat.mockReset()
    mocks.db = new Database(':memory:')
    applyDatabaseSchema(mocks.db)
    registerDatabaseHandlers()
  })

  afterEach(() => {
    mocks.db?.close()
    mocks.db = null
  })

  const addChat = (
    id: string,
    titleSource = 'placeholder',
    worktreeId: string | null = null
  ): void => {
    const now = Date.now()
    mocks
      .db!.prepare(
        `INSERT INTO conversations
         (id, title, created_at, updated_at, project_id, title_source, title_version,
          sidebar_order, project_context_version, worktree_id)
         VALUES (?, 'New Conversation', ?, ?, NULL, ?, 1, 0, 0, ?)`
      )
      .run(id, now, now, titleSource, worktreeId)
  }
  const discard = (id: unknown): Promise<{ discarded: boolean }> =>
    (mocks.handlers.get('conversations:discardIfUntouched') as RegisteredHandler)(
      {},
      id
    ) as Promise<{ discarded: boolean }>
  const exists = (id: string): boolean =>
    Boolean(mocks.db!.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id))

  it('removes a chat nothing was said in', async () => {
    addChat('empty')
    await expect(discard('empty')).resolves.toEqual({ discarded: true })
    expect(exists('empty')).toBe(false)
  })

  it('keeps a chat with a message, a run, or a title of its own', async () => {
    addChat('spoken')
    mocks
      .db!.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, timestamp)
         VALUES ('m', 'spoken', 'user', 'Hi', 1)`
      )
      .run()
    addChat('ran')
    mocks
      .db!.prepare(
        `INSERT INTO agent_runs
         (id, thread_id, surface, phase, provider, model, profile_json, started_at, updated_at)
         VALUES ('r', 'ran', 'conversation', 'running', 'p', 'm', '{}', 1, 1)`
      )
      .run()
    addChat('named', 'user')

    for (const id of ['spoken', 'ran', 'named']) {
      await expect(discard(id)).resolves.toEqual({ discarded: false })
      expect(exists(id)).toBe(true)
    }
    await expect(discard({ id: 'spoken' })).resolves.toEqual({ discarded: false })
  })

  it('keeps a chat whose worktree holds changes', async () => {
    mocks.discardWithUnusedChat.mockResolvedValue(false)
    addChat('worktree-chat', 'placeholder', null)
    mocks
      .db!.prepare("UPDATE conversations SET worktree_id = 'w1' WHERE id = 'worktree-chat'")
      .run()
    await expect(discard('worktree-chat')).resolves.toEqual({ discarded: false })
    expect(mocks.discardWithUnusedChat).toHaveBeenCalledWith('w1', 'worktree-chat')
    expect(exists('worktree-chat')).toBe(true)
  })
})
