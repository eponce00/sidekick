import { describe, expect, it } from 'vitest'
import { filterModelsByQuery, type SearchableModel } from './modelSearch'

const models: SearchableModel[] = [
  {
    id: 'qwen/qwen3-coder-32b',
    name: 'Qwen 3 Coder 32B',
    provider: 'lmstudio',
    providerInstanceName: 'Development Local',
    contextLength: 131072
  },
  {
    id: 'meta-llama/llama-4-scout',
    name: 'Llama 4 Scout',
    provider: 'openrouter',
    providerInstanceName: 'OpenRouter',
    contextLength: 32768,
    supportsVision: true
  },
  { id: 'text-embedding-small', name: 'Embedding Small' }
]

describe('model search', () => {
  it('narrows with every whitespace-separated term while preserving source order', () => {
    expect(filterModelsByQuery(models, 'qwen coder 32b')).toEqual([models[0]])
    expect(filterModelsByQuery(models, 'llama scout')).toEqual([models[1]])
  })

  it('matches provider instance, context, and capability metadata', () => {
    expect(filterModelsByQuery(models, 'development 128k')).toEqual([models[0]])
    expect(filterModelsByQuery(models, 'openrouter vision')).toEqual([models[1]])
  })

  it('returns the complete list for an empty query and no entries for a miss', () => {
    expect(filterModelsByQuery(models, '  ')).toBe(models)
    expect(filterModelsByQuery(models, 'claude opus')).toEqual([])
  })
})
