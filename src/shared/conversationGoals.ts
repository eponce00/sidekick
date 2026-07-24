import type { TodoItem } from './types'

export const CONVERSATION_GOAL_STATUSES = [
  'active',
  'paused',
  'completed',
  'blocked',
  'cleared'
] as const

export type ConversationGoalStatus = (typeof CONVERSATION_GOAL_STATUSES)[number]

export interface ConversationGoal {
  id: string
  conversationId: string
  objective: string
  status: ConversationGoalStatus
  revision: number
  continuationCount: number
  promptTokens: number
  completionTokens: number
  blockedStreak: number
  blockedKey?: string
  plan: TodoItem[]
  completionSummary?: string
  completionVerification?: string
  statusReason?: string
  currentRunId?: string
  createdAt: number
  updatedAt: number
  completedAt?: number
}

export interface CreateConversationGoalInput {
  conversationId: string
  objective: string
}

export interface UpdateConversationGoalInput {
  goalId: string
  objective: string
}

export interface ConversationGoalChangedEvent {
  goal: ConversationGoal
}

export interface ConversationGoalsAPI {
  current: (conversationId: string) => Promise<ConversationGoal | null>
  create: (input: CreateConversationGoalInput) => Promise<ConversationGoal>
  edit: (input: UpdateConversationGoalInput) => Promise<ConversationGoal>
  pause: (goalId: string) => Promise<ConversationGoal>
  resume: (goalId: string) => Promise<ConversationGoal>
  clear: (goalId: string) => Promise<ConversationGoal>
  onChanged: (callback: (change: ConversationGoalChangedEvent) => void) => () => void
}

export const CONVERSATION_GOAL_MAX_LENGTH = 4_000
