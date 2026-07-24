import type { PinnedModel } from '../../../../shared/models'
import { providerDefinition } from '../../../../shared/providerRegistry'
import type { ProviderTarget } from '../../../../shared/providerRuntime'
import {
  createPromptRefinementMessages,
  type PromptRefinementContext
} from '../../../../shared/prompts/auxiliaryPrompts'
import { completeUtilityText, type UtilityModelConfig } from './utilityCompletion'

export interface PromptRefinementConfig {
  model: UtilityModelConfig
  context: PromptRefinementContext
}

export type PromptRefinementResult =
  | { ok: true; text: string }
  | { ok: false; error: string }

type CompletePromptRefinement = typeof completeUtilityText

export function promptRefinementModelForPinnedModel(model: PinnedModel): UtilityModelConfig {
  return {
    provider: model.provider,
    providerKind: model.providerKind,
    providerInstanceId: model.providerInstanceId,
    model: model.providerModelId || model.name,
    contextLength: model.contextLength
  }
}

export function promptRefinementModelForTarget(target: ProviderTarget): UtilityModelConfig {
  return {
    provider: providerDefinition(target.providerKind).transport,
    providerKind: target.providerKind,
    providerInstanceId: target.providerInstanceId,
    model: target.model,
    contextLength: target.contextLength
  }
}

function normalizeRefinedPrompt(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const fenced = text.match(/^```(?:text|markdown|md)?\s*\n?([\s\S]*?)\n?```$/i)
  if (fenced) text = fenced[1].trim()
  return text
    .replace(/^(?:improved|refined|sharpened)(?:\s+prompt)?\s*:\s*/i, '')
    .trim()
}

function comparablePrompt(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

export async function refinePrompt(
  draft: string,
  config: PromptRefinementConfig,
  complete: CompletePromptRefinement = completeUtilityText
): Promise<PromptRefinementResult> {
  const source = draft.trim()
  if (!source) return { ok: false, error: 'Write a prompt first.' }

  const result = await complete({
    model: config.model,
    messages: createPromptRefinementMessages(source, config.context),
    maxOutputTokens: Math.min(4096, Math.max(1024, Math.ceil(source.length / 2))),
    temperature: 0.3,
    think: false,
    purpose: 'prompt-refinement',
    retries: 1
  })

  if (!result.ok) {
    return {
      ok: false,
      error: result.error?.message || 'The selected model could not refine this prompt.'
    }
  }

  const text = normalizeRefinedPrompt(result.text)
  if (!text) return { ok: false, error: 'The model returned an empty prompt.' }
  if (comparablePrompt(text) === comparablePrompt(source)) {
    return { ok: false, error: 'This prompt is already clear.' }
  }
  return { ok: true, text }
}
