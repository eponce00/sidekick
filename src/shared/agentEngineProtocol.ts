import type {
  AgentRunEventsResult,
  ResolveAgentInteractionInput,
  StartConversationAgentRunInput
} from './agentRunApi'
import type { AgentRunSnapshot } from './agentRuntime'
import type {
  ConversationGoal,
  CreateConversationGoalInput,
  UpdateConversationGoalInput
} from './conversationGoals'

export const AGENT_ENGINE_PROTOCOL_VERSION = 1 as const

export type AgentEngineCommand =
  | { type: 'run.startConversation'; input: StartConversationAgentRunInput }
  | { type: 'run.stop'; runId: string }
  | { type: 'run.events'; runId: string; afterSequence?: number }
  | { type: 'run.latest'; threadId: string }
  | { type: 'run.resolveInteraction'; input: ResolveAgentInteractionInput }
  | { type: 'goal.current'; conversationId: string }
  | { type: 'goal.create'; input: CreateConversationGoalInput }
  | { type: 'goal.edit'; input: UpdateConversationGoalInput }
  | { type: 'goal.pause'; goalId: string }
  | { type: 'goal.resume'; goalId: string }
  | { type: 'goal.clear'; goalId: string }
  | { type: 'engine.hasActiveRuns' }
  | { type: 'engine.close' }

export interface AgentEngineRequest {
  version: typeof AGENT_ENGINE_PROTOCOL_VERSION
  requestId: string
  command: AgentEngineCommand
}

export type AgentEngineResult =
  | AgentRunSnapshot
  | AgentRunEventsResult
  | ConversationGoal
  | null
  | boolean
  | { success: true }

export type AgentEngineResponse =
  | {
      version: typeof AGENT_ENGINE_PROTOCOL_VERSION
      requestId: string
      ok: true
      result: AgentEngineResult
    }
  | {
      version: typeof AGENT_ENGINE_PROTOCOL_VERSION
      requestId: string
      ok: false
      error: { name: string; message: string; stack?: string }
    }

export function assertAgentEngineRequest(value: unknown): asserts value is AgentEngineRequest {
  const request = value as Partial<AgentEngineRequest> | null
  if (
    !request ||
    request.version !== AGENT_ENGINE_PROTOCOL_VERSION ||
    typeof request.requestId !== 'string' ||
    !request.requestId ||
    !request.command ||
    typeof request.command.type !== 'string'
  ) {
    throw new Error('Unsupported or malformed agent engine request')
  }
  const supported = new Set<AgentEngineCommand['type']>([
    'run.startConversation',
    'run.stop',
    'run.events',
    'run.latest',
    'run.resolveInteraction',
    'goal.current',
    'goal.create',
    'goal.edit',
    'goal.pause',
    'goal.resume',
    'goal.clear',
    'engine.hasActiveRuns',
    'engine.close'
  ])
  if (!supported.has(request.command.type as AgentEngineCommand['type'])) {
    throw new Error('Unsupported agent engine command')
  }
}
