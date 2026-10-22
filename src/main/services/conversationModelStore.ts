import type Database from 'better-sqlite3'
import type { PinnedModel } from '../../shared/models'
import { providerKindForTransport } from '../../shared/providerRegistry'

/** Model ids are short; anything longer is not one. */
const MAX_MODEL_ID_LENGTH = 512

export function isConversationModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_MODEL_ID_LENGTH
}

/** Whether a model is the one a run recorded, which names only the provider kind and model. */
function ranOn(model: PinnedModel, run: { provider: string; model: string }): boolean {
  return (
    (model.providerKind ?? providerKindForTransport(model.provider)) === run.provider &&
    (model.providerModelId || model.name) === run.model
  )
}

/**
 * The model a run started outside the window uses, as for a chat another chat starts or wakes: the
 * one asked for, else the chat's own, else the one its latest run used, else the new-chat default.
 * A chat whose own model is gone gets none, so it asks rather than switching quietly.
 */
export function resolveConversationModel(
  models: readonly PinnedModel[],
  chat: {
    requested?: string
    own: string | null
    latestRun: { provider: string; model: string } | null
    defaultModelId?: string
  }
): PinnedModel | null {
  const byId = (id: string): PinnedModel | null => models.find((model) => model.id === id) ?? null
  if (chat.requested) return byId(chat.requested)
  if (chat.own) return byId(chat.own)
  const { latestRun } = chat
  const used = latestRun ? models.find((model) => ranOn(model, latestRun)) : undefined
  return used ?? byId(chat.defaultModelId ?? '') ?? models[0] ?? null
}

/**
 * The model each chat runs with. Choosing a model in a chat, or running the chat, records it, so
 * a choice made in one chat never changes another.
 */
export class ConversationModelStore {
  constructor(private readonly db: Database.Database) {}

  get(conversationId: string): string | null {
    const row = this.db
      .prepare('SELECT model_id FROM conversations WHERE id = ?')
      .get(conversationId) as { model_id: string | null } | undefined
    return row?.model_id ?? null
  }

  set(conversationId: string, modelId: string): boolean {
    if (!isConversationModelId(modelId)) throw new Error('Invalid model')
    return (
      this.db
        .prepare('UPDATE conversations SET model_id = ? WHERE id = ?')
        .run(modelId, conversationId).changes === 1
    )
  }

  /**
   * Gives each chat from before chats kept their own model one of its own: the model its latest
   * reply used, else the new-chat default every chat used then. A chat is left without one only
   * when neither is configured, and then shows the default until a model is chosen in it.
   */
  adoptUnassigned(models: readonly PinnedModel[], defaultModelId: string | undefined): number {
    const fallback = models.find(({ id }) => id === defaultModelId)
    const rows = this.db
      .prepare(
        `SELECT c.id, r.provider, r.model
         FROM conversations c
         LEFT JOIN agent_runs r ON r.id = (
           SELECT id FROM agent_runs
           WHERE thread_id = c.id AND parent_run_id IS NULL
           ORDER BY started_at DESC LIMIT 1
         )
         WHERE c.model_id IS NULL`
      )
      .all() as Array<{ id: string; provider: string | null; model: string | null }>
    if (!rows.length) return 0
    const update = this.db.prepare(
      'UPDATE conversations SET model_id = ? WHERE id = ? AND model_id IS NULL'
    )
    let adopted = 0
    this.db.transaction(() => {
      for (const row of rows) {
        const run = row.provider && row.model ? { provider: row.provider, model: row.model } : null
        const used = run ? models.filter((model) => ranOn(model, run)) : []
        // The same model can be set up on two providers of one kind. Every run then used the
        // default, so it is the likelier one; with no way to tell them apart, the default stands.
        const model =
          used.length === 1 ? used[0] : used.find(({ id }) => id === fallback?.id) || fallback
        if (model) adopted += update.run(model.id, row.id).changes
      }
    })()
    return adopted
  }
}
