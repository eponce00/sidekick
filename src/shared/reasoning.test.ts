import { describe, expect, it } from 'vitest'
import {
  nearestEffort,
  reasoningOptions,
  requestReasoningLevel,
  resolveReasoningLevel,
  type ReasoningModel
} from './reasoning'

function model(providerKind: ReasoningModel['providerKind'], id: string): ReasoningModel {
  return { id: `${providerKind}:${id}`, providerKind, model: id }
}

describe('reasoningOptions', () => {
  it('offers each protocol only the levels it can carry', () => {
    expect(reasoningOptions(model('ollama', 'qwen3:8b'))?.levels).toEqual(['on', 'off'])
    // gpt-oss takes a level in `think` and cannot stop reasoning.
    expect(reasoningOptions(model('ollama-cloud', 'gpt-oss:120b'))?.levels).toEqual([
      'low',
      'medium',
      'high'
    ])
    expect(reasoningOptions(model('anthropic', 'claude-opus-4-6'))?.levels).toContain('max')
    expect(reasoningOptions(model('anthropic', 'claude-3-7-sonnet'))?.levels).not.toContain('max')
    expect(reasoningOptions(model('openrouter', 'openai/o3'))?.levels).toEqual([
      'auto',
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    expect(reasoningOptions(model('llamacpp', 'qwen'))?.levels).toEqual(['auto', 'on', 'off'])
    expect(reasoningOptions(model('lmstudio', 'qwen'))?.initial).toBe('auto')
  })

  it('hides the control for a model discovery says cannot reason', () => {
    expect(
      reasoningOptions({ ...model('openrouter', 'mistral/small'), supportsReasoning: false })
    ).toBeNull()
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

describe('nearestEffort', () => {
  it('maps a level onto the nearest one a protocol accepts', () => {
    expect(nearestEffort('xhigh', ['low', 'medium', 'high'] as const)).toBe('high')
    expect(nearestEffort('minimal', ['low', 'medium', 'high'] as const)).toBe('low')
    expect(nearestEffort('on', ['low', 'medium', 'high'] as const)).toBe('medium')
    expect(nearestEffort('max', ['low', 'medium', 'high', 'max'] as const)).toBe('max')
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
