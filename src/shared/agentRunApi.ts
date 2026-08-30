import type { AgentRunEvent, AgentRunSnapshot, PendingAgentInteraction } from './agentRuntime'
import type { PinnedModel } from './models'
import type { MessageImageAttachment } from './messageImages'
import type { MessageContextAttachment } from './messageContextAttachments'

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
  /** Versioned durable journal window used for reconnect and gap repair. */
  journal?: {
    version: 1
    afterSequence: number
    nextSequence: number
    hasMore: boolean
  }
}

export interface AgentRunChangedEvent {
  event: AgentRunEvent
}

export interface PromptAdmissionItem {
  id: string
  conversationId: string
  content: string
  images?: MessageImageAttachment[]
  attachments?: MessageContextAttachment[]
  mode: ConversationRunMode
  behavior: 'pivot' | 'queue'
  position: number
  createdAt: number
  updatedAt: number
}

export interface ReplacePromptAdmissionsInput {
  conversationId: string
  queued: Array<Pick<PromptAdmissionItem, 'id' | 'content' | 'images' | 'attachments' | 'mode'>>
  pivot: Pick<PromptAdmissionItem, 'id' | 'content' | 'images' | 'attachments' | 'mode'> | null
}

export interface PromptAdmissionsResult {
  queued: PromptAdmissionItem[]
  pivot: PromptAdmissionItem | null
}
