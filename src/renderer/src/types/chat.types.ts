// Chat-related types for messages, content segments, and tool executions

import type { ConversationRunMode } from '../../../shared/agentRunApi'
import type { MessageImageAttachment } from '../../../shared/messageImages'
import type { MessageContextAttachment } from '../../../shared/messageContextAttachments'
import type { WorkspaceVerificationSummary } from '../../../shared/verification'

export interface ToolExecution {
  id: string
  callId?: string
  callIndex?: number
  title: string
  command: string
  hint?: string // Optional context shown as subtitle (e.g. "Looking for: population data")
  name?: string
  input?: Record<string, unknown>
  status: 'pending' | 'running' | 'success' | 'error' | 'denied'
  accessLevel?: 'auto' | 'confirm'
  approvalStatus?: 'pending' | 'approved' | 'denied' | 'auto'
  presentation?: import('../../../shared/agentRuntime').ToolPresentationIntent
  output?: string
  error?: string
  data?: unknown
  outputReference?: import('../../../shared/agentRuntime').ToolOutputReference
  diagnostics?: import('../../../shared/agentRuntime').ToolDiagnostic[]
  changes?: import('../../../shared/agentRuntime').ToolWorkspaceChange[]
  startedAt?: number
  completedAt?: number
  contextPercent?: number
  subAgentSteps?: import('./subagent.types').SubAgentStep[]
  /** True while the provider is still streaming the tool's input. */
  isStreaming?: boolean
}

export interface ToolLimitDecision {
  id: string
  prompt: string
  status: 'pending' | 'approved' | 'denied'
  currentLimit: number
  roundsUsed: number
  requestedAdditionalRounds: number
  isLoopGuard?: boolean
}

export interface ContentSegment {
  type:
    | 'text'
    | 'thinking'
    | 'tool'
    | 'artifact'
    | 'summary'
    | 'summarizing'
    | 'decision'
    | 'interaction'
    | 'run_status'
    | 'run_error'
    | 'verification'
    | 'file_result'
  content?: string
  tool?: ToolExecution
  artifact?: {
    type: 'react' | 'html' | 'svg'
    title: string
    code: string
    isStreaming?: boolean // True while the LLM is still generating the artifact code
  }
  summary?: {
    originalTokens: number
    newTokens: number
    messagesCompacted: number
    /** The exact model-facing historical-context payload is stored in content. */
  }
  decision?: ToolLimitDecision
  interaction?: {
    id: string
    kind: 'permission' | 'question' | 'plan_approval'
    status: 'pending' | 'resolved' | 'cancelled'
    request: Record<string, unknown>
    response?: Record<string, unknown>
  }
  status?: {
    kind: 'retrying'
    reason: string
    detail?: string
    timestamp: number
  }
  runError?: {
    code?: string
    message: string
    retryable: boolean
    recoveryAction?: string
  }
  verification?: WorkspaceVerificationSummary
  fileResult?: {
    filePath: string
    fileName: string
    ext: string // e.g. 'pdf', 'docx'
  }
  isContinuation?: boolean // Used during streaming to indicate segment is being built
}

export interface TokenUsage {
  promptTokens: number
  /** Input tokens served from a provider or inference-engine prefix cache. */
  cachedPromptTokens?: number
  completionTokens: number
  cost?: number // USD cost for this message (OpenRouter only)
  tokensPerSecond?: number // Generation speed (completion tokens / eval duration)
  /** Provider dispatch to first reasoning, text, or tool delta. */
  timeToFirstTokenMs?: number
  /** Durable wall-clock timing for the full agent run, including tools and research. */
  runStartedAt?: number
  runCompletedAt?: number
}

export interface MessageEditGeometry {
  width: number
  height: number
  viewportTop: number
}

export interface Message {
  id: string
  /** Authoritative agent journal backing this assistant materialization. */
  runId?: string
  role: 'user' | 'agent' | 'system'
  sourceRole?: 'system' | 'user' | 'assistant' | 'tool' // Provider role for synthetic loop context
  /** Identifies a public update from another project agent in a linked group chat. */
  peerLabel?: string
  /** Optional author and routing context for shared-channel messages. */
  senderLabel?: string
  senderContext?: string
  /** Compact app-authored status presentation; never used for prompt/control instructions. */
  noticeTone?: 'info' | 'success' | 'error'
  content: string
  images?: MessageImageAttachment[]
  attachments?: MessageContextAttachment[]
  thinking?: string
  segments?: ContentSegment[]
  timestamp: number
  hidden?: boolean
  /** Durable execution profile used for this request/response. */
  runMode?: ConversationRunMode
  tokenUsage?: TokenUsage // Token usage and cost info for this response
  /** Completion time for projected group-agent messages that are not backed by agent run events. */
  completedAt?: number
  checkpointHash?: string // Shadow-git checkpoint hash (set after workspace file writes)
  checkpointWorkspaceRoot?: string // Workspace that owns checkpointHash; never inferred after a move
  restoredFrom?: string // Set after a successful checkpoint restore (for 'Restored' badge)
}

// Helper type for grouped segments (thinking + tools grouped together, text/artifacts separate)
export type GroupedSegment =
  | { type: 'actions'; segments: ContentSegment[] } // Chronological thinking/tool segments
  | { type: 'content'; segment: ContentSegment } // Single text or artifact segment
