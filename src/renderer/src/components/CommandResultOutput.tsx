import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { ToolOutputReference } from '../../../shared/agentRuntime'
import { COMMAND_CAPTURE_BYTES } from '../../../shared/terminalSessions'
import type { ShellCommandResult } from '../../../shared/types'
import { copyText } from '../utils/clipboard'
import { commandStreams } from '../../../shared/commandResults'
import { commandCopyText } from '../utils/commandResult'
import { AnsiTerminalOutput } from './StructuredToolOutput'

/**
 * The one Copy control of a command, output or diff box: icon-only, it turns to a check for a
 * second once the text is on the clipboard. `text` may be a function, so a long text is built
 * only when copied.
 */
export function CommandCopyButton({
  text,
  label = 'Copy'
}: {
  text: string | (() => string)
  /** Its accessible name and tooltip. */
  label?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timerRef.current), [])
  return (
    <button
      type="button"
      className="settings-ghost-action is-small is-icon rich-tool-command-copy"
      onClick={() => {
        void copyText(typeof text === 'function' ? text() : text).then((written) => {
          if (!written) return
          setCopied(true)
          window.clearTimeout(timerRef.current)
          timerRef.current = window.setTimeout(() => setCopied(false), 1_000)
        })
      }}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

function commandEnding(result: ShellCommandResult): string | undefined {
  if (result.stoppedByUser) return 'Stopped by you'
  if (result.error?.toLowerCase().includes('timed out')) return result.error
  if (result.cancelled) return 'Cancelled'
  // A failed exit already says what the exit code says.
  return result.error && !result.error.startsWith('Command exited with code')
    ? result.error
    : undefined
}

function summarized(text: string, all: boolean): { text: string; omitted: number; total: number } {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/)
  const omitted = Math.max(0, lines.length - 20)
  return {
    total: lines.length,
    omitted,
    text:
      omitted > 0 && !all
        ? [...lines.slice(0, 10), `… ${omitted} lines omitted …`, ...lines.slice(-10)].join('\n')
        : text
  }
}

/**
 * A command's result as the user reads it: how it ended, then stdout and stderr as text. The
 * agent's copy of a long output is shortened; the note says so, and that the command's own output
 * was complete, so the card never suggests the command printed less than it did.
 */
export function CommandResultOutput({
  result,
  outputReference,
  header
}: {
  result: ShellCommandResult
  outputReference?: ToolOutputReference
  /** Draws the command line as the box's first section, with the given Copy button at its end. */
  header?: (copy?: React.ReactNode) => React.ReactNode
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const streams = useMemo(
    () =>
      commandStreams(result).map((stream) => ({ ...stream, ...summarized(stream.text, showAll) })),
    [result, showAll]
  )
  const ending = commandEnding(result)
  const failed = result.exitCode !== 0 || result.success === false
  const kept = `${Math.round(COMMAND_CAPTURE_BYTES / 1024)} KB`
  const longest = streams.reduce((most, stream) => Math.max(most, stream.total), 0)
  const copyButton =
    streams.length > 0 ? <CommandCopyButton text={() => commandCopyText(result)} /> : undefined
  // Without a command line to hold it, Copy stays on the exit-code row.
  const headerRow = header?.(copyButton)

  return (
    <>
      <div className="rich-tool-output is-terminal command-result">
        {headerRow}
        <div className="command-result-bar">
          <span className={`command-result-exit ${failed ? 'is-failed' : 'is-ok'}`}>
            Exit code {result.exitCode}
          </span>
          {ending && <span className="command-result-ending">{ending}</span>}
          {!headerRow && copyButton}
        </div>
        {streams.map((stream) => (
          <section
            key={stream.name}
            className={`command-result-stream is-${stream.name}`}
            aria-label={stream.name}
          >
            {(streams.length > 1 || stream.name === 'stderr') && (
              <div className="command-result-label">{stream.name}</div>
            )}
            <AnsiTerminalOutput value={stream.text} />
          </section>
        ))}
        {!streams.length && <div className="command-result-empty">No output</div>}
      </div>
      {longest > 20 && (
        <button
          type="button"
          className="tool-output-expand"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? 'Show summary' : `Show all ${longest.toLocaleString()} lines`}
        </button>
      )}
      {result.truncated && (
        <div className="rich-tool-truncation">
          {result.terminal
            ? 'The command printed more than its terminal keeps; SideKick kept only its last lines.'
            : `The command printed more than ${kept}; SideKick kept only the first ${kept}.`}
        </div>
      )}
      {outputReference?.truncated && (
        <div className="rich-tool-truncation">
          The agent was shown a shortened copy:{' '}
          {outputReference.returnedBytes?.toLocaleString() ?? 'part'} of{' '}
          {outputReference.originalBytes?.toLocaleString() ?? 'all the'} bytes.
          {result.truncated ? '' : " The command's own output was complete."} The agent can read the
          rest.
        </div>
      )}
    </>
  )
}
