import type { AgentRunEvent, AgentRunSnapshot, PendingAgentInteraction } from './agentRuntime'
import type { PinnedModel } from './models'

export type ConversationRunMode = 'conversation' | 'research' | 'plan'

export interface StartConversationAgentRunInput {
  id: string
  conversationId: string
  assistantMessageId: string
  model: PinnedModel
  /** Optional planner; execution always returns to model after plan approval. */
  plannerModel?: PinnedModel
  mode?: ConversationRunMode
  userLocation?: {
    city?: string
    country?: string
    timezone?: string
  }
}

export interface StartConversationAgentRunResult {
  run: AgentRunSnapshot
}

export interface ResolveAgentInteractionInput {
  interactionId: string
  response: Record<string, unknown>
  cancelled?: boolean
}

export interface AgentRunEventsResult {
  run: AgentRunSnapshot | null
  events: AgentRunEvent[]
  pendingInteractions: PendingAgentInteraction[]
}

export interface AgentRunChangedEvent {
  event: AgentRunEvent
}
