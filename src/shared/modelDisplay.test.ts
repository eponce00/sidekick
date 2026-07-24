import { describe, expect, it } from 'vitest'
import { compactModelLabel, getModelDisplayInfo, uniqueModelMetadata } from './modelDisplay'

describe('model display formatting', () => {
  it.each([
    ['anthropic/claude-opus-4.8', 'Anthropic: Claude Opus 4.8', 'Claude Opus 4.8', 'Anthropic'],
    ['~anthropic/claude-haiku-latest', 'Anthropic Claude Haiku Latest', 'Claude Haiku Latest', 'Anthropic'],
    ['google/gemini-pro', 'Google: Gemini Pro', 'Gemini Pro', 'Google'],
    ['moonshotai/kimi-k2', 'MoonshotAI Kimi K2', 'Kimi K2', 'Moonshot AI'],
    ['mistralai/mistral-large', 'Mistral: Mistral Large', 'Mistral Large', 'Mistral AI'],
    ['x-ai/grok-4', 'xAI: Grok 4', 'Grok 4', 'xAI'],
    ['aion-labs/aion-3.0', 'AionLabs: Aion-3.0', 'Aion-3.0', 'Aion Labs']
  ])('separates vendor from %s', (id, name, label, vendor) => {
    expect(getModelDisplayInfo({ id, name })).toMatchObject({ label, vendor })
  })

  it('keeps a distinct model name and exact provider id intact', () => {
    expect(
      getModelDisplayInfo({
        id: 'openrouter:home/anthropic/claude-sonnet-4',
        providerModelId: 'anthropic/claude-sonnet-4',
        name: 'Anthropic: Claude Sonnet 4'
      })
    ).toEqual({
      label: 'Claude Sonnet 4',
      vendor: 'Anthropic',
      modelIdLabel: 'claude-sonnet-4',
      fullId: 'anthropic/claude-sonnet-4',
      fullName: 'Anthropic: Claude Sonnet 4'
    })
  })

  it('does not remove a vendor when it is part of a distinct model name', () => {
    expect(
      getModelDisplayInfo({ id: 'anthracite-org/magnum-v4-72b', name: 'Magnum v4 72B' }).label
    ).toBe('Magnum v4 72B')
  })

  it('shortens only the primary model label and deduplicates metadata', () => {
    expect(
      compactModelLabel(
        { id: 'openai/a-very-long-model-name-with-a-version-suffix', name: 'OpenAI: A very long model name with a version suffix' },
        24
      )
    ).toHaveLength(24)
    expect(uniqueModelMetadata(['Anthropic', 'anthropic', 'OpenRouter', '200K context'])).toEqual([
      'Anthropic',
      'OpenRouter',
      '200K context'
    ])
  })
})
