import { toolExecutionFailed, toolExecutionSucceeded } from '../../shared/agentRuntime'
import { waitForAgentDelay } from '../../shared/agentWait'
import type { ToolOutputStore } from './toolOutputStore'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback))
}

export function registerCoreToolHandlers(
  registry: AgentToolHandlerRegistry,
  outputs: ToolOutputStore
): void {
  registry.register('wait', async ({ title, arguments: args, context }) => {
    const result = await waitForAgentDelay(args.seconds, { signal: context.signal })
    return result.completed
      ? toolExecutionSucceeded({ title, data: result })
      : toolExecutionFailed({
          title,
          code: 'cancelled',
          message: 'Wait cancelled',
          status: 'cancelled',
          data: result
        })
  })
  registry.register('tool_output', async ({ title, arguments: args }) => {
    const result = await outputs.read(
      String(args.handle || ''),
      bounded(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      bounded(args.max_bytes, 50 * 1024, 1_024, 50 * 1024)
    )
    return toolExecutionSucceeded({ title, data: result, modelContent: result.content })
  })
}
