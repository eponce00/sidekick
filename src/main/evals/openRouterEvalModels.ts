/**
 * Development-only free model pool. These identifiers are never added to app
 * settings or bundled as user-facing defaults.
 */
export const OPENROUTER_FREE_EVAL_MODELS = [
  'poolside/laguna-s-2.1:free',
  'google/gemma-4-26b-a4b-it:free',
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free'
] as const

export const DEFAULT_OPENROUTER_SYSTEM_EVAL_MODEL = OPENROUTER_FREE_EVAL_MODELS[0]
