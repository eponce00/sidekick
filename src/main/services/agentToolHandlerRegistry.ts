import {
  toolExecutionFailed,
  type AgentApprovalPreview,
  type ToolExecutionResult
} from '../../shared/agentRuntime'
import type { AgentToolExecutionContext } from './agentToolRegistry'

export interface AgentToolHandlerInput {
  name: string
  title: string
  arguments: Record<string, unknown>
  context: AgentToolExecutionContext
}

export type AgentToolHandler = (input: AgentToolHandlerInput) => Promise<ToolExecutionResult>

/** Which run, chat and call a preview is for, for previews that depend on their state. */
export type AgentToolPreviewContext = Pick<
  AgentToolExecutionContext,
  'conversationId' | 'runId' | 'toolCallId'
>

/** Describes what an approved call would change, for the approval card. */
export type AgentToolApprovalPreview = (
  args: Record<string, unknown>,
  context?: AgentToolPreviewContext
) => Promise<AgentApprovalPreview | undefined>

/** Scoped registry used by one run; registrations are explicit and duplicate names fail closed. */
export class AgentToolHandlerRegistry {
  private readonly handlers = new Map<string, AgentToolHandler>()
  private readonly previews = new Map<string, AgentToolApprovalPreview>()

  register(
    names: string | readonly string[],
    handler: AgentToolHandler,
    options: { preview?: AgentToolApprovalPreview } = {}
  ): () => void {
    const registered = typeof names === 'string' ? [names] : [...names]
    for (const name of registered) {
      if (this.handlers.has(name)) throw new Error(`Duplicate agent tool handler: ${name}`)
    }
    for (const name of registered) {
      this.handlers.set(name, handler)
      if (options.preview) this.previews.set(name, options.preview)
    }
    return () => {
      for (const name of registered) {
        if (this.handlers.get(name) !== handler) continue
        this.handlers.delete(name)
        this.previews.delete(name)
      }
    }
  }

  preview(
    name: string,
    args: Record<string, unknown>,
    context?: AgentToolPreviewContext
  ): Promise<AgentApprovalPreview | undefined> {
    return this.previews.get(name)?.(args, context) ?? Promise.resolve(undefined)
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
