import { toolExecutionSucceeded } from '../../shared/agentRuntime'
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
  registry.register('tool_output', async ({ title, arguments: args }) => {
    const result = await outputs.read(
      String(args.handle || ''),
      bounded(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      bounded(args.max_bytes, 50 * 1024, 1_024, 50 * 1024)
    )
    // Without the range, a model reading in pieces could not tell where to go on or that it had
    // reached the end.
    const end = result.offset + Buffer.byteLength(result.content, 'utf8')
    const range =
      `[tool_output: bytes ${result.offset}–${end} of ${result.totalBytes}. ` +
      (result.nextOffset === null
        ? 'This is the end of the stored output.]'
        : `Continue from offset ${result.nextOffset}.]`)
    return toolExecutionSucceeded({
      title,
      data: result,
      modelContent: `${result.content}${result.content.endsWith('\n') ? '' : '\n'}${range}`
    })
  })
}
