import type { PromptModelInput, PromptModelProfile, ModelFamily } from './promptTypes'

const FAMILY_PATTERNS: ReadonlyArray<[ModelFamily, RegExp]> = [
  ['anthropic', /(^|[/:\s_-])(anthropic|claude)([/:\s_.-]|$)/i],
  ['openai', /(^|[/:\s_-])(openai|chatgpt|gpt|o[134])([/:\s_.-]|$)/i],
  ['google', /(^|[/:\s_-])(google|gemini|gemma)([/:\s_.-]|$)/i],
  ['qwen', /(^|[/:\s_-])qwen/i],
  ['llama', /(^|[/:\s_-])(meta-llama|llama)/i],
  ['mistral', /(^|[/:\s_-])(mistral|mixtral|codestral)/i],
  ['deepseek', /(^|[/:\s_-])deepseek/i],
  ['grok', /(^|[/:\s_-])(x-ai|grok)/i]
]

export function inferModelFamily(model: PromptModelInput): ModelFamily {
  const identity = [model.id, model.providerModelId, model.name].filter(Boolean).join(' ')
  return FAMILY_PATTERNS.find(([, pattern]) => pattern.test(identity))?.[0] ?? 'generic'
}

export function createPromptModelProfile(model: PromptModelInput): PromptModelProfile {
  const family = inferModelFamily(model)
  return {
    family,
    provider: model.provider,
    providerKind: model.providerKind,
    modelId: model.providerModelId || model.id,
    displayName: model.name,
    instructionStyle:
      family === 'qwen' || family === 'llama' || family === 'mistral' || family === 'deepseek'
        ? 'compact-structured'
        : 'direct'
  }
}
