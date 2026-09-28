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
  /**
   * An interrupted run this one picks up from its durable journal. Only the
   * latest run of the conversation can be continued, and only once.
   */
  continuesRunId?: string
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

/** Asks a running conversation run to take a pending message at its next model step. */
export interface SteerConversationRunInput {
  runId: string
  /** The pending message, already stored as a prompt admission. */
  admissionId: string
}

export interface SteerConversationRunResult {
  /** False when the run cannot take it; the message then waits for the run to end. */
  accepted: boolean
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

export interface BrowserHumanTakeoverSnapshot {
  active: boolean
  conversationId: string
  sessionId: string
  pageTitle: string
  url: string
  humanVerificationRequired: boolean
  message?: string
  screenshot?: {
    id: string
    url: string
    kind: 'viewport' | 'fullPage' | 'element'
    width: number
    height: number
  }
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
