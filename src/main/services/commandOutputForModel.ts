import { commandStreams } from '../../shared/commandResults'
import type { ShellCommandResult } from '../../shared/types'
import { COMMAND_CAPTURE_BYTES } from '../../shared/terminalSessions'
import type { BoundedToolOutput, ToolOutputStore } from './toolOutputStore'

/** The first lines of a command result: how it ended, and what SideKick did not keep. */
export function commandResultHeader(result: ShellCommandResult): string {
  const lines = [`Exit code: ${result.exitCode}`]
  if (result.stoppedByUser) lines.push('The user stopped this command.')
  else if (result.cancelled) lines.push('The command was cancelled before it finished.')
  if (result.error && !result.stoppedByUser) lines.push(`Error: ${result.error}`)
  if (result.truncated) {
    const kept = `${Math.round(COMMAND_CAPTURE_BYTES / 1024)} KB`
    lines.push(
      (result.terminal
        ? 'The command printed more than its terminal keeps; SideKick kept only its last lines. '
        : `The command printed more than ${kept}; SideKick kept only the first ${kept}. `) +
        (result.outputPath
          ? `All of it is in ${result.outputPath}; search or read that file with a command.`
          : 'To keep all of a long output, write it to a file and read the file.')
    )
  }
  return lines.join('\n')
}

/**
 * What the model reads of a finished command. JSON escaped every line break of the output into
 * one long line, and a cut in the middle of it left a string the model could not parse; an agent
 * then took SideKick's shortened copy of a download for a short file. Each stream is shown as
 * text, cut on whole lines, and the note at a cut says it was SideKick that shortened it.
 */
export async function commandOutputForModel(
  outputs: ToolOutputStore,
  result: ShellCommandResult
): Promise<BoundedToolOutput> {
  const sections = commandStreams(result)
  const header = commandResultHeader(result) + (sections.length ? '' : '\nNo output.')
  return outputs.applySections(header, sections, {
    describeCut: (section, amount, handle, offset) =>
      `SideKick shortened the output shown in the chat: ${amount} of ${section.name} left out here.` +
      (result.truncated ? '' : " The command's own output was complete.") +
      ` Read the part left out with tool_output, handle "${handle}" and offset ${offset}.`
  })
}
