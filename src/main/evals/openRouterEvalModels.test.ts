import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPENROUTER_SYSTEM_EVAL_MODEL,
  OPENROUTER_FREE_EVAL_MODELS
} from './openRouterEvalModels'

describe('OpenRouter development evaluation model pool', () => {
  it('contains only distinct explicit free variants and a member default', () => {
    expect(new Set(OPENROUTER_FREE_EVAL_MODELS).size).toBe(OPENROUTER_FREE_EVAL_MODELS.length)
    expect(OPENROUTER_FREE_EVAL_MODELS.every((model) => model.endsWith(':free'))).toBe(true)
    expect(OPENROUTER_FREE_EVAL_MODELS).toContain(DEFAULT_OPENROUTER_SYSTEM_EVAL_MODEL)
  })
})
