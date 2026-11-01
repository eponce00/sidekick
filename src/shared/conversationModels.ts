import type { PinnedModel } from './models'

/**
 * The model a chat runs with. Each chat keeps its own; the `selectedModel` setting is only where a
 * new chat starts, the model last chosen in any chat.
 */
export interface ConversationModelChoice {
  /** The chat's own model, else the new-chat default. Empty when there is neither. */
  modelId: string
  /** That model, when it is configured and enabled. */
  model: PinnedModel | null
  /**
   * The chat's own model is no longer configured or enabled. The chat asks for another instead of
   * quietly running on a different one.
   */
  unavailable: boolean
}

export function conversationModelChoice(
  models: readonly PinnedModel[],
  conversationModelId: string | null | undefined,
  defaultModelId: string | null | undefined
): ConversationModelChoice {
  const modelId = conversationModelId || defaultModelId || ''
  const model = modelId ? (models.find(({ id }) => id === modelId) ?? null) : null
  return { modelId, model, unavailable: Boolean(conversationModelId) && !model }
}

/**
 * A readable name for a model id that is no longer configured. Ids are
 * `<transport>:<instance>/<model>`; instance ids never contain a slash, but model ids may.
 */
export function modelNameFromId(modelId: string): string {
  const colon = modelId.indexOf(':')
  const slash = modelId.indexOf('/', colon + 1)
  return modelId.slice(slash >= 0 ? slash + 1 : colon + 1) || modelId
}
