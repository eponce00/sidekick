// Sub-agent types for delegated task execution

export type SubAgentStatus = 'pending' | 'running' | 'completed' | 'error' | 'cancelled'

export interface SubAgentStats {
  iterations: number
  toolCallsExecuted: number
  promptTokens: number
  completionTokens: number
  durationMs: number
}

/** A single step in the sub-agent's execution, for mini-chat display */
export interface SubAgentStep {
  type: 'tool_call' | 'tool_result' | 'thinking' | 'response'
  name?: string      // Tool name (for tool_call/tool_result)
  content: string    // Summary of args, result text, thinking text, or final response
  status?: 'success' | 'error' | 'running'
}

export interface SubAgentResult {
  success: boolean
  result: string
  error?: string
  stats: SubAgentStats
  steps: SubAgentStep[]
}

export interface SubAgentInfo {
  id: string
  task: string // The prompt/task given to the sub-agent
  status: SubAgentStatus
  startTime: number
  model: string
  currentStep?: string // Brief description of what the sub-agent is currently doing
}

export interface SubAgentCallbacks {
  onStatusChange: (id: string, info: SubAgentInfo) => void
  onStepUpdate: (id: string, steps: SubAgentStep[]) => void
  onActivity: (activity: import('./activity.types').ActivityItem, conversationId?: string) => void
  onActivityUpdate: (
    id: string,
    updates: Partial<import('./activity.types').ActivityItem>,
    conversationId?: string
  ) => void
}

/**
 * Configuration for sub-agent behavior
 */
export interface SubAgentConfig {
  /** Maximum LLM call iterations before forcing completion (default: 25) */
  maxIterations: number
  /** Maximum concurrent sub-agents (default: 2) */
  maxConcurrent: number
}

export const DEFAULT_SUBAGENT_CONFIG: SubAgentConfig = {
  maxIterations: 25,
  maxConcurrent: 2
}
