import { useState } from 'react'
import { ArrowDownToLine, CornerDownLeft, Square, SquareTerminal } from 'lucide-react'
import { terminalSessionIsLive } from '../../../shared/terminalSessions'
import { requestTerminalView, useTerminalSessionForTool } from '../utils/terminalSessionStore'
import './CommandLiveView.css'

/**
 * A running command at a glance: its last lines as its terminal shows them, and the controls a
 * user at that terminal would have. Shown while the command runs, under its row in the chat.
 */
export function CommandLiveView({ toolCallId }: { toolCallId: string }): React.JSX.Element | null {
  const session = useTerminalSessionForTool(toolCallId)
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
      {session.tail.length > 0 && (
        <pre className="command-live-tail" aria-live="polite">
          {session.tail.join('\n')}
        </pre>
      )}
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
      <div className="command-live-actions">
        <span className="command-live-state">
          <span className="command-live-dot" aria-hidden="true" />
          {waiting
            ? 'Waiting for input'
            : session.background
              ? 'Running in the background'
              : 'Running'}
        </span>
        <button type="button" onClick={() => void window.api.terminal.stop(session.id)}>
          <Square size={11} />
          Stop
        </button>
        {!session.background && (
          <button
            type="button"
            onClick={() => void window.api.terminal.moveToBackground(session.id)}
            title="Let the agent go on while this keeps running"
          >
            <ArrowDownToLine size={11} />
            Background
          </button>
        )}
        <button type="button" onClick={() => requestTerminalView(session.id)}>
          <SquareTerminal size={11} />
          Open in Terminal
        </button>
      </div>
    </div>
  )
}
