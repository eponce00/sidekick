import { describe, expect, it } from 'vitest'
import { conversationModelChoice, modelNameFromId } from './conversationModels'
import type { PinnedModel } from './models'

const qwen: PinnedModel = {
  id: 'ollama:ollama-local/qwen3:8b',
  name: 'Qwen 3 8B',
  provider: 'ollama',
  providerModelId: 'qwen3:8b'
}
const sonnet: PinnedModel = {
  id: 'openrouter:openrouter/anthropic/claude-sonnet-4',
  name: 'Claude Sonnet 4',
  provider: 'openrouter',
  providerModelId: 'anthropic/claude-sonnet-4'
}

describe('conversation model choice', () => {
  it('keeps the chat on its own model whatever the new-chat default is', () => {
    expect(conversationModelChoice([qwen, sonnet], sonnet.id, qwen.id)).toEqual({
      modelId: sonnet.id,
      model: sonnet,
      unavailable: false
    })
  })

  it('starts a chat with no model of its own on the new-chat default', () => {
    expect(conversationModelChoice([qwen, sonnet], null, qwen.id)).toEqual({
      modelId: qwen.id,
      model: qwen,
      unavailable: false
    })
  })

  it('reports a chat whose own model is no longer set up instead of using another', () => {
    const gone = 'lmstudio:lm-studio/qwen2.5-coder-14b'
    expect(conversationModelChoice([qwen, sonnet], gone, qwen.id)).toEqual({
      modelId: gone,
      model: null,
      unavailable: true
    })
  })

  it('is not unavailable when there is no model at all yet', () => {
    expect(conversationModelChoice([], null, '')).toEqual({
      modelId: '',
      model: null,
      unavailable: false
    })
  })

  it('names a model from its id, keeping slashes in the model part', () => {
    expect(modelNameFromId('lmstudio:lm-studio/qwen2.5-coder-14b')).toBe('qwen2.5-coder-14b')
    expect(modelNameFromId(sonnet.id)).toBe('anthropic/claude-sonnet-4')
    expect(modelNameFromId('ollama:qwen3:8b')).toBe('qwen3:8b')
  })
})
