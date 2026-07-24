import type { CollaborationAgentSessionMessage } from '../../../shared/collaboration'
import type { PinnedModel } from '../../../shared/models'
import { estimateVisibleMessageTokens } from './messageFormatting'
import { messageTokenUsageFromMetadata } from './messageTokenUsage'

export interface GroupAgentContextSnapshot {
  sessionId: string
  currentTokens: number
  maxTokens: number
  selectedModel: string
  model?: PinnedModel
}

function providerUsage(record: CollaborationAgentSessionMessage): {
  promptTokens: number | null
  completionTokens: number
} {
  const usage = messageTokenUsageFromMetadata(record.metadata)
  const hasProviderCount = Boolean(
    usage && (Math.round(usage.promptTokens) > 0 || Math.round(usage.completionTokens) > 0)
  )
  return {
    promptTokens: hasProviderCount && usage ? Math.round(usage.promptTokens) : null,
    completionTokens: usage ? Math.round(usage.completionTokens) : 0
  }
}

function estimatedRecordTokens(record: CollaborationAgentSessionMessage): number {
  if (record.role === 'system') return 0
  return (
    estimateVisibleMessageTokens(record.content) +
    (record.toolCalls.length ? estimateVisibleMessageTokens(JSON.stringify(record.toolCalls)) : 0)
  )
}

/**
 * Returns the best available estimate of the provider context after the latest
 * session record. New runs persist authoritative provider usage; older records
 * fall back to a conservative visible-content estimate.
 */
export function groupAgentContextTokens(records: CollaborationAgentSessionMessage[]): number {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]
    if (record.role !== 'assistant') continue
    const { promptTokens, completionTokens } = providerUsage(record)
    if (promptTokens === null) continue
    const subsequentTokens = records
      .slice(index + 1)
      .reduce((total, subsequent) => total + estimatedRecordTokens(subsequent), 0)
    return promptTokens + completionTokens + subsequentTokens
  }

  return records.reduce((total, record) => total + estimatedRecordTokens(record), 0)
}
