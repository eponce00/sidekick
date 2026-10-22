import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'

type RegisteredHandler = (...args: unknown[]) => unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, RegisteredHandler>(),
  db: null as Database.Database | null,
  settings: {} as Record<string, unknown>
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: RegisteredHandler) => {
      mocks.handlers.set(channel, handler)
    })
  }
}))
vi.mock('./state', () => ({ getDb: () => mocks.db }))
vi.mock('./settings', () => ({ loadStoredSettings: () => mocks.settings }))

import { registerConversationModelHandlers } from './conversationModels'

const QWEN = 'ollama:ollama-local/qwen3:8b'
const SONNET = 'openrouter:openrouter/anthropic/claude-sonnet-4'

function modelOf(id: string): string | null {
  return (
    mocks.db!.prepare('SELECT model_id FROM conversations WHERE id = ?').get(id) as {
      model_id: string | null
    }
  ).model_id
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.db = new Database(':memory:')
  applyDatabaseSchema(mocks.db)
  mocks.settings = {
    selectedModel: QWEN,
    providerInstances: [
      {
        id: 'ollama-local',
        name: 'Ollama',
        type: 'ollama',
        enabled: true,
        baseUrl: 'http://localhost:11434',
        modelSource: 'discover',
        models: [{ id: 'qwen3:8b', enabled: true }]
      },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        type: 'openrouter',
        enabled: true,
        baseUrl: 'https://openrouter.ai/api/v1',
        modelSource: 'discover',
        models: [{ id: 'anthropic/claude-sonnet-4', enabled: true }]
      }
    ]
  }
  const insert = mocks.db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at, model_id)
     VALUES (?, ?, 1, 1, ?)`
  )
  insert.run('first', 'First chat', QWEN)
  insert.run('second', 'Second chat', QWEN)
  insert.run('older', 'Chat from before', null)
})

afterEach(() => {
  mocks.db?.close()
  mocks.db = null
})

describe('conversation model IPC', () => {
  it('gives chats from before their own model as it starts', () => {
    registerConversationModelHandlers()
    expect(modelOf('older')).toBe(QWEN)
  })

  it('changes the model of the chat it names and no other', async () => {
    registerConversationModelHandlers()
    const setModel = mocks.handlers.get('conversations:setModel') as RegisteredHandler

    await expect(setModel({}, 'first', SONNET)).resolves.toEqual({ success: true })

    expect(modelOf('first')).toBe(SONNET)
    expect(modelOf('second')).toBe(QWEN)
  })

  it('refuses a model that is not set up, or a malformed chat', async () => {
    registerConversationModelHandlers()
    const setModel = mocks.handlers.get('conversations:setModel') as RegisteredHandler

    await expect(setModel({}, 'first', 'lmstudio:lm-studio/qwen2.5-coder-14b')).rejects.toThrow(
      'That model is not set up'
    )
    await expect(setModel({}, 'first', { id: SONNET })).rejects.toThrow('That model is not set up')
    await expect(setModel({}, 'x'.repeat(101), SONNET)).rejects.toThrow('Invalid chat')
    expect(modelOf('first')).toBe(QWEN)
  })

  it('still starts when the older chats cannot be given a model', () => {
    mocks.settings = { providerInstances: 'not a list' }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(() => registerConversationModelHandlers()).not.toThrow()
      expect(mocks.handlers.has('conversations:setModel')).toBe(true)
      expect(modelOf('older')).toBeNull()
    } finally {
      warning.mockRestore()
    }
  })
})
