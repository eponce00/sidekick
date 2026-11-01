import { describe, expect, it } from 'vitest'
import {
  reasoningOptions,
  requestReasoningLevel,
  resolveReasoningLevel,
  type ReasoningModel
} from './reasoning'

function model(
  providerKind: ReasoningModel['providerKind'],
  id: string,
  details: Partial<ReasoningModel> = {}
): ReasoningModel {
  return {
    id: `${providerKind}:${id}`,
    providerKind,
    model: id,
    supportsReasoning: true,
    ...details
  }
}

describe('reasoningOptions', () => {
  it('offers the levels the server lists for the model, least first', () => {
    expect(
      reasoningOptions(
        model('lmstudio', 'gemma-4', { reasoningLevels: ['on', 'off'], reasoningDefault: 'on' })
      )
    ).toEqual({ levels: ['off', 'on'], initial: 'on' })
    expect(
      reasoningOptions(
        model('openrouter', 'openai/o3', { reasoningLevels: ['low', 'medium', 'high'] })
      )
    ).toEqual({ levels: ['low', 'medium', 'high'], initial: 'medium' })
  })

  it('shows nothing where there is no choice to make', () => {
    // A model that cannot stop reasoning and has no levels.
    expect(
      reasoningOptions(model('lmstudio', 'deepseek-r1', { reasoningLevels: ['on'] }))
    ).toBeNull()
    expect(
      reasoningOptions(model('openrouter', 'openrouter/auto', { reasoningLevels: [] }))
    ).toBeNull()
    expect(
      reasoningOptions(model('openrouter', 'mistral/small', { supportsReasoning: false }))
    ).toBeNull()
    // Unknown support: the user can mark the model as reasoning in its settings.
    expect(
      reasoningOptions(model('openai-compatible', 'qwen', { supportsReasoning: undefined }))
    ).toBeNull()
  })

  it('falls back to what the protocol can carry when the server lists no levels', () => {
    expect(reasoningOptions(model('ollama', 'qwen3:8b'))?.levels).toEqual(['off', 'on'])
    // gpt-oss takes a level in `think` and cannot stop reasoning.
    expect(reasoningOptions(model('ollama-cloud', 'gpt-oss:120b'))?.levels).toEqual([
      'low',
      'medium',
      'high'
    ])
    expect(reasoningOptions(model('anthropic', 'claude-opus-4-6'))?.levels).toContain('max')
    expect(reasoningOptions(model('anthropic', 'claude-3-7-sonnet'))?.levels).not.toContain('max')
    expect(reasoningOptions(model('openrouter', 'openai/o3'))?.levels).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    expect(reasoningOptions(model('llamacpp', 'qwen'))).toEqual({
      levels: ['off', 'on'],
      initial: 'on'
    })
    expect(reasoningOptions(model('lmstudio', 'qwen'))?.initial).toBe('medium')
  })
})

describe('resolveReasoningLevel', () => {
  it('uses the level chosen for the model when it still offers it', () => {
    const qwen = model('openrouter', 'qwen/qwen3')
    expect(resolveReasoningLevel(qwen, { reasoningLevels: { [qwen.id]: 'high' } })).toBe('high')
    // A level from another protocol falls back to the model's own starting level.
    const ollama = model('ollama', 'qwen3')
    expect(resolveReasoningLevel(ollama, { reasoningLevels: { [ollama.id]: 'xhigh' } })).toBe('on')
  })

  it('seeds the starting level from the older on/off switches', () => {
    expect(resolveReasoningLevel(model('ollama', 'qwen3'), { ollamaThinkingEnabled: false })).toBe(
      'off'
    )
    // gpt-oss cannot turn reasoning off, so the old switch leaves it at its default.
    expect(
      resolveReasoningLevel(model('ollama', 'gpt-oss:20b'), { ollamaThinkingEnabled: false })
    ).toBe('medium')
    expect(
      resolveReasoningLevel(model('openrouter', 'openai/o3'), { openRouterThinkingEnabled: true })
    ).toBe('medium')
    expect(resolveReasoningLevel(model('openrouter', 'openai/o3'), {})).toBe('off')
  })
})

describe('requestReasoningLevel', () => {
  it('prefers the level and reads the older switch otherwise', () => {
    expect(requestReasoningLevel({ reasoningLevel: 'low', thinkingEnabled: false })).toBe('low')
    expect(requestReasoningLevel({ thinkingEnabled: false })).toBe('off')
    expect(requestReasoningLevel({ thinkingEnabled: true })).toBe('on')
    expect(requestReasoningLevel({})).toBeUndefined()
  })
})
