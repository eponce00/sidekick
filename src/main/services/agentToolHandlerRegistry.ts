import { toolExecutionFailed, type ToolExecutionResult } from '../../shared/agentRuntime'
import type { AgentToolExecutionContext } from './agentToolRegistry'

export interface AgentToolHandlerInput {
  name: string
  title: string
  arguments: Record<string, unknown>
  context: AgentToolExecutionContext
}

export type AgentToolHandler = (input: AgentToolHandlerInput) => Promise<ToolExecutionResult>

/** Scoped registry used by one run; registrations are explicit and duplicate names fail closed. */
export class AgentToolHandlerRegistry {
  private readonly handlers = new Map<string, AgentToolHandler>()

  register(names: string | readonly string[], handler: AgentToolHandler): () => void {
    const registered = typeof names === 'string' ? [names] : [...names]
    for (const name of registered) {
      if (this.handlers.has(name)) throw new Error(`Duplicate agent tool handler: ${name}`)
    }
    for (const name of registered) this.handlers.set(name, handler)
    return () => {
      for (const name of registered) {
        if (this.handlers.get(name) === handler) this.handlers.delete(name)
      }
    }
  }

  has(name: string): boolean {
    return this.handlers.has(name)
  }

  async execute(input: AgentToolHandlerInput): Promise<ToolExecutionResult> {
    const handler = this.handlers.get(input.name)
    if (!handler) {
      return toolExecutionFailed({
        title: input.title,
        code: 'unknown_tool',
        message: `No runtime implementation exists for ${input.name}`
      })
    }
    return handler(input)
  }
}
