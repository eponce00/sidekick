import { commandStreams } from '../../../shared/commandResults'
import type { ShellCommandResult } from '../../../shared/types'

/** A finished foreground command's result, as the shell tool records it. */
export function commandResultFrom(data: unknown): ShellCommandResult | null {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
  return record && typeof record.stdout === 'string' && typeof record.exitCode === 'number'
    ? (record as unknown as ShellCommandResult)
    : null
}

/** The output as text to paste elsewhere: the streams in order, never the recorded JSON. */
export function commandCopyText(result: ShellCommandResult): string {
  return commandStreams(result)
    .map((stream) => stream.text.replace(/\r?\n$/, ''))
    .join('\n\n')
}
