import {
  checkpointFallbackTitleFromDiff,
  CHECKPOINT_TITLE_VERSION,
  normalizeCheckpointTitle,
  type CheckpointHistoryItem
} from '../../../shared/checkpointTitles'
import { providerKindForTransport } from '../../../shared/providerRegistry'
import type { PinnedModel } from '../types/models.types'
import { createCheckpointTitleMessages } from '../services/prompts'
import { FAST_MODEL_CONTEXT_LIMIT } from '../utils/chatHelpers'
import { generateConversationTitle } from '../utils/chatPanelHelpers'
import { useIdleBackgroundJob, type IdleBackgroundJobResult } from './useIdleBackgroundJob'

interface CheckpointTitleBackfillOptions {
  enabled: boolean
  workspaceFolder: string | null
  checkpoints: CheckpointHistoryItem[]
  model?: PinnedModel
  fastModelName?: string
  isAgentBusy: boolean
  onTitleApplied: (hash: string, title: string) => void
}

/** Refines visible History labels without mutating the shadow-Git commit chain. */
export function useCheckpointTitleBackfill(options: CheckpointTitleBackfillOptions): void {
  useIdleBackgroundJob({
    enabled: options.enabled,
    jobKey: `${options.workspaceFolder ?? 'no-workspace'}:${options.model?.id ?? 'no-model'}`,
    foregroundBusy: options.isAgentBusy,
    initialDelayMs: 4_000,
    betweenWorkMs: 5_000,
    emptyRecheckMs: 5 * 60_000,
    maxWorkPerSession: 20,
    label: 'CheckpointTitleBackfill',
    runOne: async (): Promise<IdleBackgroundJobResult> => {
      if (!options.workspaceFolder || !options.model) return { didWork: false }

      const candidates = options.checkpoints.filter(
        (checkpoint) =>
          checkpoint.titleSource !== 'user' && checkpoint.titleVersion < CHECKPOINT_TITLE_VERSION
      )
      for (const checkpoint of candidates) {
        const identity = {
          workspaceRoot: options.workspaceFolder,
          hash: checkpoint.hash,
          expectedTitle: checkpoint.message
        }
        const claim = await window.api.workspace.claimCheckpointTitleBackfill(identity)
        if (!claim.claimed) continue

        const [diffResult, context] = await Promise.all([
          window.api.workspace.getCheckpointDiff(options.workspaceFolder, checkpoint.hash),
          window.api.workspace.getCheckpointTitleContext(
            options.workspaceFolder,
            checkpoint.hash,
            checkpoint.timestamp
          )
        ])
        const userContent = context?.userContent.trim() || checkpoint.message
        const assistantContent = context?.assistantContent.trim() || checkpoint.message
        let applied = false
        const modelName =
          options.fastModelName || options.model.providerModelId || options.model.name
        const generatedTitle = await generateConversationTitle(
          {
            provider: options.model.provider,
            providerKind:
              options.model.providerKind ?? providerKindForTransport(options.model.provider),
            providerInstanceId: options.model.providerInstanceId,
            model: modelName,
            contextLength: Math.min(
              options.model.contextLength || FAST_MODEL_CONTEXT_LIMIT,
              FAST_MODEL_CONTEXT_LIMIT
            ),
            purpose: 'checkpoint-title',
            retries: 0,
            onUpdateTitle: async (_checkpointHash, title) => {
              const usefulTitle = normalizeCheckpointTitle(title)
              if (!usefulTitle) return
              const result = await window.api.workspace.completeCheckpointTitleBackfill({
                ...identity,
                title: usefulTitle
              })
              if (!result.applied) return
              applied = true
              options.onTitleApplied(checkpoint.hash, usefulTitle)
            }
          },
          checkpoint.hash,
          createCheckpointTitleMessages(
            userContent,
            assistantContent,
            diffResult.ok ? diffResult.diff : ''
          )
        )

        if (!applied) {
          const fallbackTitle = checkpointFallbackTitleFromDiff(
            diffResult.ok ? diffResult.diff : ''
          )
          const result = await window.api.workspace.completeCheckpointTitleBackfill({
            ...identity,
            title: fallbackTitle
          })
          if (result.applied) options.onTitleApplied(checkpoint.hash, fallbackTitle)
          else if (!generatedTitle) {
            await window.api.workspace.failCheckpointTitleBackfill({
              ...identity,
              error: 'Checkpoint title provider did not return a usable title'
            })
          }
        }
        return { didWork: true }
      }

      return { didWork: false }
    }
  })
}
