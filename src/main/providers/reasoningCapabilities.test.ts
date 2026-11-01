import { describe, expect, it } from 'vitest'
import {
  anthropicReasoning,
  liteLLMReasoning,
  llamaCppReasoning,
  lmStudioReasoning,
  ollamaReasoning,
  openRouterReasoning
} from './reasoningCapabilities'

describe('reasoning capabilities', () => {
  it('reads LM Studio’s allowed options and default', () => {
    expect(lmStudioReasoning({ allowed_options: ['off', 'on'], default: 'on' })).toEqual({
      supportsReasoning: true,
      reasoningLevels: ['off', 'on'],
      reasoningDefault: 'on'
    })
    // A model that always reasons offers no choice.
    expect(lmStudioReasoning({ allowed_options: ['on'], default: 'on' }).reasoningLevels).toEqual([
      'on'
    ])
    expect(lmStudioReasoning(undefined)).toEqual({})
  })

  it('reads OpenRouter’s efforts, whether reasoning can stop, and its defaults', () => {
    expect(
      openRouterReasoning({
        supported_efforts: ['high', 'medium', 'low'],
        default_effort: 'medium',
        mandatory: false
      })
    ).toEqual({
      supportsReasoning: true,
      reasoningLevels: ['off', 'low', 'medium', 'high'],
      reasoningDefault: 'medium'
    })
    expect(
      openRouterReasoning({ supported_efforts: ['high', 'low'], mandatory: true }).reasoningLevels
    ).toEqual(['low', 'high'])
    // Null takes every effort; absent takes none, so only on and off.
    expect(
      openRouterReasoning({ supported_efforts: null, mandatory: false }).reasoningLevels
    ).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(openRouterReasoning({ mandatory: false, default_enabled: false })).toMatchObject({
      reasoningLevels: ['off', 'on'],
      reasoningDefault: 'off'
    })
  })

  it('reads Ollama’s think values, where false alone means no thinking', () => {
    expect(ollamaReasoning({ values: ['low', 'medium', 'high'], default: 'medium' })).toEqual({
      supportsReasoning: true,
      reasoningLevels: ['low', 'medium', 'high'],
      reasoningDefault: 'medium'
    })
    expect(ollamaReasoning({ values: [true, false], default: true })).toMatchObject({
      reasoningLevels: ['off', 'on'],
      reasoningDefault: 'on'
    })
    expect(ollamaReasoning({ values: [false] }).supportsReasoning).toBe(false)
    expect(ollamaReasoning(undefined)).toEqual({})
  })

  it('reads Anthropic’s thinking types and effort levels', () => {
    const yes = { supported: true }
    const no = { supported: false }
    expect(
      anthropicReasoning({
        thinking: { supported: true, types: { adaptive: yes, enabled: no, disabled: yes } },
        effort: { supported: true, low: yes, medium: yes, high: yes, xhigh: no, max: yes }
      })
    ).toEqual({ supportsReasoning: true, reasoningLevels: ['off', 'low', 'medium', 'high', 'max'] })
    // A budgeted model without effort levels.
    expect(
      anthropicReasoning({
        thinking: { supported: true, types: { enabled: yes, disabled: yes } },
        effort: { supported: false }
      }).reasoningLevels
    ).toEqual(['off', 'low', 'medium', 'high'])
    expect(anthropicReasoning({ thinking: { supported: false } })).toEqual({
      supportsReasoning: false,
      reasoningLevels: []
    })
  })

  it('reads LiteLLM’s levels, or its per-effort flags', () => {
    expect(
      liteLLMReasoning({ supports_reasoning: true, reasoning_effort_levels: ['low', 'high'] })
    ).toMatchObject({ reasoningLevels: ['off', 'low', 'high'] })
    expect(
      liteLLMReasoning({
        supports_reasoning: true,
        supports_xhigh_reasoning_effort: true,
        thinking_always_on: true,
        default_reasoning_effort: 'high'
      })
    ).toEqual({
      supportsReasoning: true,
      reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
      reasoningDefault: 'high'
    })
    expect(liteLLMReasoning({})).toEqual({})
  })

  it('reads what llama.cpp’s chat template does with reasoning', () => {
    expect(
      llamaCppReasoning({
        chat_template_caps: { supports_reasoning_effort: true },
        chat_template: ''
      })
    ).toMatchObject({ reasoningLevels: ['off', 'low', 'medium', 'high'] })
    expect(
      llamaCppReasoning({ chat_template: '{% if enable_thinking %}<think>{% endif %}' })
    ).toEqual({ supportsReasoning: true, reasoningLevels: ['off', 'on'], reasoningDefault: 'on' })
    expect(llamaCppReasoning({ chat_template: '{{ messages }}' })).toEqual({ reasoningLevels: [] })
  })
})
