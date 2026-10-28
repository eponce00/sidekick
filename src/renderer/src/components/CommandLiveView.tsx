import { useState } from 'react'
import { ArrowDownToLine, CornerDownLeft, SquareTerminal } from 'lucide-react'
import { terminalSessionIsLive } from '../../../shared/terminalSessions'
import { requestTerminalView, useTerminalSessionForTool } from '../utils/terminalSessionStore'
import { CommandCopyButton } from './CommandResultOutput'
import { StopGlyph } from './StopGlyph'
import './CommandLiveView.css'

/**
 * A running command at a glance: its last lines as its terminal shows them, and the controls a
 * user at that terminal would have. Shown while the command runs, under its row in the chat.
 */
export function CommandLiveView({
  toolCallId,
  sessionId
}: {
  toolCallId?: string
  /** A command named directly, as by a wait for it. */
  sessionId?: string
}): React.JSX.Element | null {
  const session = useTerminalSessionForTool(toolCallId, sessionId)
  const [answer, setAnswer] = useState('')
  if (!session || !terminalSessionIsLive(session.state)) return null
  const waiting = session.state === 'waiting_for_input'
  const sendAnswer = (): void => {
    void window.api.terminal.write(session.id, `${answer}${session.pty ? '\r' : '\n'}`)
    setAnswer('')
  }

  return (
    // Clicks here act on the command, not on the step list the view sits in.
    <div
      className={`command-live${waiting ? ' is-waiting' : ''}`}
      onClick={(event) => event.stopPropagation()}
    >
      {/* The same box as a finished command's result: the command line with its actions, what it
          has printed so far, then its status row. */}
      <div className="command-live-box command-result">
        <div className="rich-tool-command">
          <span aria-hidden="true">$</span>
          <code>{session.command}</code>
          <span className="rich-tool-command-actions">
            {/* Only the lines kept so far, unlike a finished box's Copy, which has the whole output. */}
            {session.tail.length > 0 && (
              <CommandCopyButton label="Copy shown lines" text={() => session.tail.join('\n')} />
            )}
            <button
              type="button"
              className="settings-ghost-action is-small is-icon rich-tool-open-terminal"
              onClick={() => requestTerminalView(session.id)}
              aria-label="Open in Terminal"
              title="Open in Terminal"
            >
              <SquareTerminal size={13} />
            </button>
          </span>
        </div>
        {session.tail.length > 0 && (
          <pre className="command-live-tail" aria-live="polite">
            {session.tail.join('\n')}
          </pre>
        )}
        {/* The box's last section: what the command is doing, and its controls. */}
        <div className="command-live-actions">
          <span className="command-live-state">
            <span className="command-live-dot" aria-hidden="true" />
            {waiting
              ? 'Waiting for input'
              : session.background
                ? 'Running in the background'
                : 'Running'}
          </span>
          {!session.background && (
            <button
              type="button"
              className="settings-ghost-action is-small"
              onClick={() => void window.api.terminal.moveToBackground(session.id)}
              title="Let the agent go on while this keeps running"
            >
              <ArrowDownToLine size={12} />
              Background
            </button>
          )}
          <button
            type="button"
            className="settings-ghost-action is-small"
            onClick={() => void window.api.terminal.stop(session.id)}
          >
            <StopGlyph />
            Stop
          </button>
        </div>
      </div>
      {waiting && (
        <form
          className="command-live-answer"
          onSubmit={(event) => {
            event.preventDefault()
            sendAnswer()
          }}
        >
          <input
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="The command is waiting for input. Type a reply"
            aria-label="Reply to the command"
          />
          <button type="submit" title="Send, then press Enter">
            <CornerDownLeft size={12} />
            Send
          </button>
        </form>
      )}
    </div>
  )
}
