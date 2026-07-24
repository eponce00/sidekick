import { providerKindForTransport } from '../../../shared/providerRegistry'
import type { PinnedModel } from '../types/models.types'
import { FAST_MODEL_CONTEXT_LIMIT } from '../utils/chatHelpers'
import { generateConversationTitle } from '../utils/chatPanelHelpers'
import { createConversationTitleMessages } from '../services/prompts'
import { decideConversationTitleBackfill } from '../services/titles/conversationTitleBackfill'
import { useIdleBackgroundJob, type IdleBackgroundJobResult } from './useIdleBackgroundJob'

interface ConversationTitleBackfillOptions {
  enabled: boolean
  model?: PinnedModel
  fastModelName?: string
  isAgentBusy: boolean
  onTitleApplied: (conversationId: string, title: string) => void
}

/** Improves app-owned conversation titles through the shared idle maintenance scheduler. */
export function useConversationTitleBackfill(options: ConversationTitleBackfillOptions): void {
  useIdleBackgroundJob({
    enabled: options.enabled,
    jobKey: options.model?.id ?? 'no-model',
    foregroundBusy: options.isAgentBusy,
    initialDelayMs: 12_000,
    betweenWorkMs: 5_000,
    emptyRecheckMs: 5 * 60_000,
    maxWorkPerSession: 20,
    label: 'TitleBackfill',
    runOne: async (): Promise<IdleBackgroundJobResult> => {
      if (!options.model) return { didWork: false }

      const candidates = await window.api.conversations.listTitleBackfillCandidates(8)
      let preservedCandidate = false
      for (const candidate of candidates) {
        const identity = { id: candidate.id, expectedTitle: candidate.title }
        if (decideConversationTitleBackfill(candidate) === 'preserve') {
          await window.api.conversations.preserveTitle(identity)
          preservedCandidate = true
          continue
        }

        const claim = await window.api.conversations.claimTitleBackfill(identity)
        if (!claim.claimed) continue

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
            retries: 0,
            onUpdateTitle: async (conversationId, title) => {
              const result = await window.api.conversations.completeTitleBackfill({
                ...identity,
                title
              })
              if (!result.applied) return
              applied = true
              options.onTitleApplied(conversationId, title)
            }
          },
          candidate.id,
          createConversationTitleMessages(
            candidate.firstUserMessage,
            candidate.firstAssistantMessage || undefined
          )
        )

        if (!generatedTitle && !applied) {
          await window.api.conversations.failTitleBackfill({
            ...identity,
            error: 'Title provider did not return a usable title'
          })
        }
        return { didWork: true }
      }

      return preservedCandidate
        ? { didWork: true, countTowardLimit: false, nextDelayMs: 2_500 }
        : { didWork: false }
    }
  })
}
