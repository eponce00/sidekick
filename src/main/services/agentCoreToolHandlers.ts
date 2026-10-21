import { toolExecutionFailed, toolExecutionSucceeded } from '../../shared/agentRuntime'
import type { ToolOutputStore } from './toolOutputStore'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'

/** A handle anywhere in the argument; the store reads only the handle itself. */
const HANDLE_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback))
}

export function registerCoreToolHandlers(
  registry: AgentToolHandlerRegistry,
  outputs: ToolOutputStore
): void {
  registry.register('tool_output', async ({ title, arguments: args }) => {
    // Without a handle the call is a wrong argument, not a failure of the store.
    if (!HANDLE_SHAPE.test(String(args.handle ?? '')))
      return toolExecutionFailed({
        title,
        code: 'invalid_arguments',
        message: `tool_output needs the handle (a UUID) that a shortened result named; received: ${String(args.handle ?? '').slice(0, 120) || '(nothing)'}`,
        retryable: true,
        recoveryAction: 'correct_input',
        recovery:
          'Copy the handle from the note at the end of the shortened result. Only shortened results have one; read project files with read and command output with read_command_output.'
      })
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
