import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import type { PinnedModel } from '../../shared/models'
import { ConversationModelStore, resolveConversationModel } from './conversationModelStore'

const qwen: PinnedModel = {
  id: 'ollama:ollama-local/qwen3:8b',
  name: 'Qwen 3 8B',
  provider: 'ollama',
  providerKind: 'ollama',
  providerInstanceId: 'ollama-local',
  providerModelId: 'qwen3:8b'
}
const sonnet: PinnedModel = {
  id: 'openrouter:openrouter/anthropic/claude-sonnet-4',
  name: 'Claude Sonnet 4',
  provider: 'openrouter',
  providerKind: 'openrouter',
  providerInstanceId: 'openrouter',
  providerModelId: 'anthropic/claude-sonnet-4'
}
// The same model set up on a second Ollama.
const qwenOnDesktop: PinnedModel = {
  ...qwen,
  id: 'ollama:ollama-desktop/qwen3:8b',
  providerInstanceId: 'ollama-desktop'
}

let db: Database.Database
let store: ConversationModelStore

function addChat(id: string, modelId: string | null = null): void {
  db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at, sidebar_order, model_id)
     VALUES (?, ?, 1, 1, 0, ?)`
  ).run(id, id, modelId)
}

function addRun(
  id: string,
  chatId: string,
  model: PinnedModel,
  startedAt: number,
  parentRunId: string | null = null
): void {
  db.prepare(
    `INSERT INTO agent_runs
     (id, thread_id, parent_run_id, surface, phase, provider, model, profile_json, started_at,
      updated_at)
     VALUES (?, ?, ?, 'conversation', 'completed', ?, ?, '{}', ?, ?)`
  ).run(id, chatId, parentRunId, model.providerKind, model.providerModelId, startedAt, startedAt)
}

beforeEach(() => {
  db = new Database(':memory:')
  applyDatabaseSchema(db)
  store = new ConversationModelStore(db)
})

afterEach(() => db.close())

describe('conversation model store', () => {
  it('changes the model of one chat and leaves another alone', () => {
    addChat('first', qwen.id)
    addChat('second', qwen.id)

    expect(store.set('first', sonnet.id)).toBe(true)

    expect(store.get('first')).toBe(sonnet.id)
    expect(store.get('second')).toBe(qwen.id)
  })

  it('refuses a value that is not a model id', () => {
    addChat('first', qwen.id)
    expect(() => store.set('first', '')).toThrow('Invalid model')
    expect(() => store.set('first', 'x'.repeat(513))).toThrow('Invalid model')
    expect(store.get('first')).toBe(qwen.id)
  })

  it('gives an older chat the model its latest reply used', () => {
    addChat('older')
    addRun('run-1', 'older', qwen, 1)
    addRun('run-2', 'older', sonnet, 2)
    // A sub-agent shares the chat's thread but is not the chat's own reply.
    addRun('sub-agent', 'older', qwen, 3, 'run-2')

    expect(store.adoptUnassigned([qwen, sonnet], qwen.id)).toBe(1)
    expect(store.get('older')).toBe(sonnet.id)
  })

  it('gives an older chat the new-chat default when its last model is gone or never ran', () => {
    const removed: PinnedModel = { ...qwen, id: 'ollama:old/llama3', providerModelId: 'llama3' }
    addChat('removed-model')
    addRun('run-1', 'removed-model', removed, 1)
    addChat('never-ran')

    expect(store.adoptUnassigned([qwen, sonnet], sonnet.id)).toBe(2)
    expect(store.get('removed-model')).toBe(sonnet.id)
    expect(store.get('never-ran')).toBe(sonnet.id)
  })

  it('prefers the default when the last model is set up on two providers', () => {
    addChat('ambiguous')
    addRun('run-1', 'ambiguous', qwen, 1)

    store.adoptUnassigned([qwen, qwenOnDesktop, sonnet], qwenOnDesktop.id)
    expect(store.get('ambiguous')).toBe(qwenOnDesktop.id)

    addChat('ambiguous-without-default')
    addRun('run-2', 'ambiguous-without-default', qwen, 2)
    store.adoptUnassigned([qwen, qwenOnDesktop, sonnet], sonnet.id)
    expect(store.get('ambiguous-without-default')).toBe(sonnet.id)
  })

  it('leaves chats that have a model, and leaves a chat without one when nothing is set up', () => {
    addChat('chosen', sonnet.id)
    addChat('nothing-set-up')

    expect(store.adoptUnassigned([], undefined)).toBe(0)
    expect(store.get('chosen')).toBe(sonnet.id)
    expect(store.get('nothing-set-up')).toBeNull()
  })
})

describe('model for a run started outside the window', () => {
  const run = { provider: 'ollama', model: 'qwen3:8b' }

  it('uses the model asked for, else the chat’s own', () => {
    expect(
      resolveConversationModel([qwen, sonnet], {
        requested: qwen.id,
        own: sonnet.id,
        latestRun: null
      })
    ).toBe(qwen)
    expect(
      resolveConversationModel([qwen, sonnet], {
        own: sonnet.id,
        latestRun: run,
        defaultModelId: qwen.id
      })
    ).toBe(sonnet)
  })

  it('does not switch a chat whose own model is gone to another', () => {
    expect(
      resolveConversationModel([qwen, sonnet], {
        own: 'lmstudio:lm-studio/qwen2.5-coder-14b',
        latestRun: run,
        defaultModelId: qwen.id
      })
    ).toBeNull()
  })

  it('falls back to the latest run’s model, then the new-chat default', () => {
    expect(
      resolveConversationModel([qwen, sonnet], {
        own: null,
        latestRun: run,
        defaultModelId: sonnet.id
      })
    ).toBe(qwen)
    expect(
      resolveConversationModel([qwen, sonnet], {
        own: null,
        latestRun: null,
        defaultModelId: sonnet.id
      })
    ).toBe(sonnet)
  })
})
