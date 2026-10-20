import type { ShellCommandResult } from './types'

/**
 * What a finished command printed, stream by stream, as the agent and the chat both show it:
 * stdout and stderr, leaving out an empty one. A terminal merges both into its output.
 */
export function commandStreams(result: ShellCommandResult): { name: string; text: string }[] {
  if (result.terminal) return result.stdout ? [{ name: 'output', text: result.stdout }] : []
  return [
    { name: 'stdout', text: result.stdout },
    { name: 'stderr', text: result.stderr }
  ].filter((stream) => stream.text)
}
