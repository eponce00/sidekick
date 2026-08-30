import { randomUUID } from 'crypto'
import {
  AGENT_ENGINE_PROTOCOL_VERSION,
  assertAgentEngineRequest,
  type AgentEngineCommand,
  type AgentEngineRequest,
  type AgentEngineResponse,
  type AgentEngineResult
} from '../../shared/agentEngineProtocol'
import type { AgentRuntimeCoordinator } from './agentRuntimeCoordinator'

export interface AgentEngineTransport {
  request(request: AgentEngineRequest): Promise<AgentEngineResponse>
}

export class LocalAgentEngineTransport implements AgentEngineTransport {
  constructor(private readonly runtime: AgentRuntimeCoordinator) {}

  async request(request: AgentEngineRequest): Promise<AgentEngineResponse> {
    try {
      assertAgentEngineRequest(request)
      const result = await this.dispatch(request.command)
      return {
        version: AGENT_ENGINE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result
      }
    } catch (error) {
      return {
        version: AGENT_ENGINE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {})
        }
      }
    }
  }

  private async dispatch(command: AgentEngineCommand): Promise<AgentEngineResult> {
    switch (command.type) {
      case 'run.startConversation':
        return this.runtime.startConversation(command.input)
      case 'run.stop':
        return this.runtime.stop(command.runId)
      case 'run.events':
        return this.runtime.events(command.runId, command.afterSequence)
      case 'run.latest':
        return this.runtime.latest(command.threadId)
      case 'run.resolveInteraction':
        this.runtime.resolveInteraction(command.input)
        return { success: true }
      case 'goal.current':
        return this.runtime.currentGoal(command.conversationId)
      case 'goal.create':
        return this.runtime.createGoal(command.input)
      case 'goal.edit':
        return this.runtime.editGoal(command.input)
      case 'goal.pause':
        return this.runtime.pauseGoal(command.goalId)
      case 'goal.resume':
        return this.runtime.resumeGoal(command.goalId)
      case 'goal.clear':
        return this.runtime.clearGoal(command.goalId)
      case 'engine.hasActiveRuns':
        return this.runtime.hasActiveRuns()
      case 'engine.close':
        await this.runtime.close()
        return { success: true }
    }
  }
}

export class AgentEngineClient {
  constructor(private readonly transport: AgentEngineTransport) {}

  async request<T extends AgentEngineResult>(command: AgentEngineCommand): Promise<T> {
    const requestId = randomUUID()
    const response = await this.transport.request({
      version: AGENT_ENGINE_PROTOCOL_VERSION,
      requestId,
      command
    })
    if (response.version !== AGENT_ENGINE_PROTOCOL_VERSION || response.requestId !== requestId) {
      throw new Error('Agent engine returned an invalid protocol response')
    }
    if (!response.ok) {
      const error = new Error(response.error.message)
      error.name = response.error.name
      throw error
    }
    return response.result as T
  }
}
