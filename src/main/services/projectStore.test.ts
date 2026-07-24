import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { ProjectStore } from './projectStore'
import { CollaborationStore } from './collaborationStore'

describe('ProjectStore', () => {
  let db: Database.Database
  let store: ProjectStore

  beforeEach(() => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    store = new ProjectStore(db)
  })

  afterEach(() => db.close())

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

  it('archives affected groups and preserves agent identity when a project is removed', () => {
    const first = store.create('/tmp/sidekick-project-a', 'Desktop')
    const second = store.create('/tmp/sidekick-project-b', 'API')
    const collaboration = new CollaborationStore(db)
    const detail = collaboration.createGroup({
      title: 'Release',
      participants: [
        {
          projectId: first.id,
          providerTarget: { providerKind: 'ollama', model: 'first' }
        },
        {
          projectId: second.id,
          providerTarget: { providerKind: 'ollama', model: 'second' }
        }
      ]
    })
    const participant = detail.participants.find(({ projectId }) => projectId === first.id)!
    const { mission } = collaboration.sendUserMessage({
      groupId: detail.group.id,
      text: 'Coordinate the release'
    })
    const event = collaboration.appendAgentEvent({
      groupId: detail.group.id,
      missionId: mission.id,
      participantId: participant.id,
      kind: 'agent_message',
      payload: { text: 'Finished the desktop work' }
    })

    expect(() => store.remove(first.id)).toThrow('Stop active group missions')
    collaboration.updateMission(mission.id, { status: 'stopped' })
    store.remove(first.id)

    expect(collaboration.getGroup(detail.group.id)?.status).toBe('archived')
    expect(collaboration.listEvents(detail.group.id).find(({ id }) => id === event.id)).toEqual(
      expect.objectContaining({
        actorParticipantId: null,
        payload: expect.objectContaining({
          metadata: expect.objectContaining({
            actorLabel: 'Desktop agent',
            projectName: 'Desktop'
          })
        })
      })
    )
    expect(store.get(first.id)).toBeUndefined()
  })
})
