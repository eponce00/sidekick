import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { resolve } from 'path'
import { ProjectStore } from './projectStore'

describe('ProjectStore', () => {
  let db: Database.Database
  let store: ProjectStore

  beforeEach(() => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    store = new ProjectStore(db)
  })

  afterEach(() => db.close())

  const insertProjectChat = (projectId: string): string => {
    const id = `chat-${Math.random().toString(36).slice(2)}`
    insertConversation(id)
    store.moveConversation({ conversationId: id, projectId })
    return id
  }

  const insertConversation = (id: string, updatedAt: number = 1): void => {
    db.prepare(
      'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(id, id, updatedAt, updatedAt)
  }

  it('creates one durable project per folder', () => {
    const first = store.create('/tmp/sidekick-project', 'SideKick')
    const second = store.create('/tmp/sidekick-project', 'Ignored duplicate')

    expect(second.id).toBe(first.id)
    expect(store.list()).toEqual([
      expect.objectContaining({ id: first.id, name: 'SideKick', conversation_count: 0 })
    ])
  })

  it('binds a chat to its first project and lets it detach and reattach there', () => {
    const project = store.create('/tmp/sidekick-project', 'SideKick')
    insertConversation('conversation-1')

    store.moveConversation({ conversationId: 'conversation-1', projectId: project.id })
    expect(
      db
        .prepare(
          `SELECT project_id, home_workspace_root, home_project_name
           FROM conversations WHERE id = ?`
        )
        .get('conversation-1')
    ).toEqual({
      project_id: project.id,
      home_workspace_root: project.folder_path,
      home_project_name: project.name
    })

    store.moveConversation({ conversationId: 'conversation-1', projectId: null })
    expect(store.getConversationContext('conversation-1')).toEqual(
      expect.objectContaining({
        projectId: null,
        homeWorkspaceRoot: project.folder_path,
        isDetached: true
      })
    )

    store.moveConversation({ conversationId: 'conversation-1', projectId: project.id })
    expect(store.getConversationContext('conversation-1')).toEqual(
      expect.objectContaining({ projectId: project.id, isDetached: false, contextVersion: 3 })
    )
  })

  it('rejects direct and detached moves into another project', () => {
    const first = store.create('/tmp/sidekick-first', 'First')
    const second = store.create('/tmp/sidekick-second', 'Second')
    insertConversation('conversation-1')
    store.moveConversation({ conversationId: 'conversation-1', projectId: first.id })

    expect(() =>
      store.moveConversation({ conversationId: 'conversation-1', projectId: second.id })
    ).toThrow('cannot move between projects')

    store.moveConversation({ conversationId: 'conversation-1', projectId: null })
    expect(() =>
      store.moveConversation({ conversationId: 'conversation-1', projectId: second.id })
    ).toThrow('belongs to First')
  })

  it('persists manual order inside one group without changing project context', () => {
    insertConversation('conversation-1', 1)
    insertConversation('conversation-2', 2)
    insertConversation('conversation-3', 3)

    const result = store.moveConversation({
      conversationId: 'conversation-1',
      projectId: null,
      anchorConversationId: 'conversation-3',
      placement: 'before'
    })
    const order = db
      .prepare(
        `SELECT id FROM conversations
         WHERE project_id IS NULL ORDER BY sidebar_order ASC, updated_at DESC`
      )
      .all() as Array<{ id: string }>

    expect(order.map(({ id }) => id)).toEqual([
      'conversation-1',
      'conversation-3',
      'conversation-2'
    ])
    expect(result.transition).toBeNull()
    expect(result.conversation.project_context_version).toBe(0)
  })

  it('blocks membership changes while a run is active', () => {
    const project = store.create('/tmp/sidekick-project', 'SideKick')
    insertConversation('conversation-1')
    db.prepare(
      `INSERT INTO agent_runs
       (id, thread_id, surface, phase, provider, model, profile_json,
        last_sequence, started_at, updated_at)
       VALUES (?, ?, 'conversation', 'streaming', 'test', 'test', ?, 0, ?, ?)`
    ).run(
      'run-1',
      'conversation-1',
      JSON.stringify({ surface: 'conversation', capabilities: [] }),
      1,
      1
    )

    expect(() =>
      store.moveConversation({ conversationId: 'conversation-1', projectId: project.id })
    ).toThrow('Stop the active run')
  })

  it('adds side-by-side folders with unique names and refuses one inside another', () => {
    const root = resolve('/work/app')
    const project = store.create(root, 'App')
    const updated = store.updateFolders({
      projectId: project.id,
      add: [
        { path: resolve('/work/api') },
        { path: resolve('/other/api') },
        // A name that is a top-level entry of the primary folder would hide that entry.
        { path: resolve('/more/src'), reservedNames: ['src'] }
      ]
    })
    expect(updated.folders).toEqual([
      { name: 'api', path: resolve('/work/api') },
      { name: 'api-2', path: resolve('/other/api') },
      { name: 'src-2', path: resolve('/more/src') }
    ])
    for (const path of ['/work/app/lib', '/work', '/work/api/inner']) {
      expect(() =>
        store.updateFolders({ projectId: project.id, add: [{ path: resolve(path) }] })
      ).toThrow('inside one of the project')
    }
    expect(store.foldersForRoot(root)).toEqual(updated.folders)
    expect(store.getConversationContext(insertProjectChat(project.id)).folders).toEqual(
      updated.folders
    )
  })

  it('swaps the primary folder, keeping the project’s chats, memory and folder list', () => {
    const project = store.create(resolve('/work/app'), 'App')
    store.updateFolders({ projectId: project.id, add: [{ path: resolve('/work/api') }] })
    const chat = insertProjectChat(project.id)
    db.prepare(
      'INSERT INTO workspace_memory (workspace_path, content, updated_at) VALUES (?, ?, 1)'
    ).run(resolve('/work/app'), 'Remember this')

    const swapped = store.updateFolders({ projectId: project.id, makePrimary: 'api' })

    expect(swapped.folder_path).toBe(resolve('/work/api'))
    expect(swapped.folders).toEqual([{ name: 'app', path: resolve('/work/app') }])
    expect(store.getConversationContext(chat)).toMatchObject({
      workspaceRoot: resolve('/work/api'),
      homeWorkspaceRoot: resolve('/work/api'),
      folders: [{ name: 'app', path: resolve('/work/app') }]
    })
    expect(db.prepare('SELECT workspace_path FROM workspace_memory').get()).toEqual({
      workspace_path: resolve('/work/api')
    })
  })

  it('gives a worktree chat the worktree’s copy of a folder in its repository and others as they are', () => {
    const project = store.create(resolve('/repo/app'), 'App')
    store.updateFolders({
      projectId: project.id,
      add: [{ path: resolve('/repo/lib') }, { path: resolve('/elsewhere/docs') }]
    })
    db.prepare(
      `INSERT INTO managed_worktrees
       (id, source_project_id, repository_root, worktree_root, folder_path, branch, created_at, last_used_at)
       VALUES ('wt', ?, ?, ?, ?, 'sidekick/x', 1, 1)`
    ).run(project.id, resolve('/repo'), resolve('/wt/x'), resolve('/wt/x/app'))

    expect(store.foldersForRoot(resolve('/wt/x/app'))).toEqual([
      { name: 'lib', path: resolve('/wt/x/lib') },
      { name: 'docs', path: resolve('/elsewhere/docs') }
    ])
  })

  it('keeps conversations when a project is removed', () => {
    const project = store.create('/tmp/sidekick-project', 'SideKick')
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, project_id)
       VALUES (?, ?, ?, ?, ?)`
    ).run('conversation-1', 'Architecture', 1, 1, project.id)

    store.remove(project.id)

    expect(store.list()).toEqual([])
    expect(
      db
        .prepare('SELECT project_id, home_workspace_root FROM conversations WHERE id = ?')
        .get('conversation-1')
    ).toEqual({ project_id: null, home_workspace_root: project.folder_path })
  })
})
