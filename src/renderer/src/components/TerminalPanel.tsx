import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ArrowDownToLine, Check, Copy, CornerDownLeft, Square, SquareTerminal } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import {
  terminalSessionIsLive,
  type TerminalSessionSummary
} from '../../../shared/terminalSessions'
import { subscribeTerminalOutput, useTerminalSessions } from '../utils/terminalSessionStore'
import './TerminalPanel.css'

function stateLabel(session: TerminalSessionSummary): string {
  switch (session.state) {
    case 'running':
      return session.background ? 'Running in the background' : 'Running'
    case 'waiting_for_input':
      return 'Waiting for input'
    case 'exited':
      return session.exitCode === 0 ? 'Finished' : `Exited with code ${session.exitCode}`
    case 'stopped':
      return 'Stopped'
    case 'timed_out':
      return 'Timed out'
    default:
      return 'Failed to run'
  }
}

function duration(session: TerminalSessionSummary, now: number): string {
  const seconds = Math.max(0, Math.round(((session.endedAt ?? now) - session.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** A terminal's colours from the app's own, so it matches the light or dark theme. */
function terminalTheme(): NonNullable<ConstructorParameters<typeof Terminal>[0]>['theme'] {
  // The theme's colours are set on the body, where the app switches light and dark.
  const style = getComputedStyle(document.body)
  const token = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback
  return {
    background: token('--surface-1', '#111318'),
    foreground: token('--text-primary', '#e6e6e6'),
    cursor: token('--accent', '#3ad6b8'),
    selectionBackground: token('--accent-subtle', 'rgba(58, 214, 184, 0.25)')
  }
}

/**
 * A real terminal view of one command: its output replayed from the start, then live. A
 * command in a pseudo-terminal takes keystrokes directly, as at its own terminal.
 */
function CommandTerminal({
  session,
  copyTextRef
}: {
  session: TerminalSessionSummary
  /** Set to read the output as the terminal shows it. */
  copyTextRef: React.MutableRefObject<(() => string) | null>
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const live = terminalSessionIsLive(session.state)
  const acceptsKeys = live && session.pty

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const terminal = new Terminal({
      // Over pipes a bare "\n" ends a line; a pseudo-terminal says where the cursor goes.
      convertEol: !session.pty,
      fontFamily: getComputedStyle(document.body).getPropertyValue('--font-mono') || 'monospace',
      fontSize: 12,
      scrollback: 10_000,
      theme: terminalTheme(),
      allowProposedApi: true
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    copyTextRef.current = () => {
      terminal.selectAll()
      const text = terminal.getSelection()
      terminal.clearSelection()
      return text.trimEnd()
    }
    const fitToHost = (): void => {
      try {
        fit.fit()
      } catch {
        // A hidden panel has no size to fit.
      }
    }
    fitToHost()

    let offset = 0
    let replayed = false
    const pending: Array<{ data: string; at: number }> = []
    const write = (data: string, at: number): void => {
      const end = at + data.length
      if (end <= offset) return
      terminal.write(data.slice(Math.max(0, offset - at)))
      offset = end
    }
    const unsubscribe = subscribeTerminalOutput(session.id, (data, at) => {
      if (replayed) write(data, at)
      else pending.push({ data, at })
    })
    void window.api.terminal.read(session.id, 0).then((window_) => {
      if (window_) {
        if (window_.truncatedBefore) terminal.write('\x1b[2m[earlier output not kept]\x1b[0m\r\n')
        terminal.write(window_.data)
        offset = window_.offset + window_.data.length
      }
      replayed = true
      for (const chunk of pending.splice(0)) write(chunk.data, chunk.at)
    })
    const input = terminal.onData((data) => {
      if (terminal.options.disableStdin) return
      void window.api.terminal.write(session.id, data)
    })
    const observer = new ResizeObserver(fitToHost)
    observer.observe(host)
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalTheme()
    })
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      unsubscribe()
      input.dispose()
      observer.disconnect()
      themeObserver.disconnect()
      terminal.dispose()
      terminalRef.current = null
      copyTextRef.current = null
    }
  }, [copyTextRef, session.id, session.pty])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.disableStdin = !acceptsKeys
    terminal.options.cursorBlink = acceptsKeys
    if (session.state === 'waiting_for_input' && acceptsKeys) terminal.focus()
  }, [acceptsKeys, session.state])

  return <div className="terminal-panel-screen" ref={hostRef} />
}

/** A reply line for a command reading input over a pipe, which does not echo keystrokes. */
function PipeInput({ session }: { session: TerminalSessionSummary }): React.JSX.Element {
  const [value, setValue] = useState('')
  return (
    <form
      className="terminal-panel-input"
      onSubmit={(event) => {
        event.preventDefault()
        void window.api.terminal.write(session.id, `${value}\n`)
        setValue('')
      }}
    >
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Type a line for the command"
        aria-label="Input for the command"
      />
      <button type="submit">
        <CornerDownLeft size={12} />
        Send
      </button>
    </form>
  )
}

export function TerminalPanel({
  conversationId,
  requestedSessionId
}: {
  conversationId: string | null
  /** A command someone asked to see; changes select it. */
  requestedSessionId?: { id: string; at: number } | null
}): React.JSX.Element {
  const sessions = useTerminalSessions(conversationId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [handledRequestAt, setHandledRequestAt] = useState(requestedSessionId?.at)
  if (requestedSessionId && requestedSessionId.at !== handledRequestAt) {
    setHandledRequestAt(requestedSessionId.at)
    setSelectedId(requestedSessionId.id)
  }
  const [copied, setCopied] = useState(false)
  const copyTextRef = useRef<(() => string) | null>(null)
  const [now, setNow] = useState(Date.now)
  const anyLive = sessions.some((session) => terminalSessionIsLive(session.state))
  useEffect(() => {
    if (!anyLive) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [anyLive])

  // Without a choice, show what is happening now: the newest running command, else the newest.
  const selected =
    sessions.find((session) => session.id === selectedId) ??
    [...sessions].reverse().find((session) => terminalSessionIsLive(session.state)) ??
    sessions.at(-1)

  if (!sessions.length) {
    return (
      <div className="terminal-panel-empty">
        <SquareTerminal size={22} aria-hidden="true" />
        <strong>No commands yet</strong>
        <span>
          Commands the agent runs in this conversation show up here as they run. You can watch them,
          stop them, and type into them.
        </span>
      </div>
    )
  }

  const live = selected ? terminalSessionIsLive(selected.state) : false
  return (
    <div className="terminal-panel">
      <ul className="terminal-panel-list" aria-label="Agent commands">
        {[...sessions].reverse().map((session) => (
          <li key={session.id}>
            <button
              type="button"
              className={`terminal-panel-item is-${session.state}${session.id === selected?.id ? ' is-selected' : ''}`}
              onClick={() => setSelectedId(session.id)}
              aria-current={session.id === selected?.id}
            >
              <span className="terminal-panel-item-dot" aria-hidden="true" />
              <span className="terminal-panel-item-text">
                <span className="terminal-panel-item-title">{session.title}</span>
                <code>{session.command}</code>
              </span>
              <span className="terminal-panel-item-meta">
                {session.background && terminalSessionIsLive(session.state) ? 'bg · ' : ''}
                {duration(session, now)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <div className="terminal-panel-view">
          <div className="terminal-panel-toolbar">
            <span className={`terminal-panel-state is-${selected.state}`}>
              {stateLabel(selected)}
            </span>
            <span className="terminal-panel-cwd" title={selected.cwd}>
              {selected.cwd}
            </span>
            <button
              type="button"
              onClick={() => {
                const text = copyTextRef.current?.()
                if (!text) return
                void navigator.clipboard.writeText(text).then(() => {
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1_000)
                })
              }}
              title="Copy the output"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            {live && !selected.background && (
              <button
                type="button"
                onClick={() => void window.api.terminal.moveToBackground(selected.id)}
                title="Let the agent go on while this keeps running"
              >
                <ArrowDownToLine size={12} />
                Background
              </button>
            )}
            {live && (
              <button
                type="button"
                className="is-danger"
                onClick={() => void window.api.terminal.stop(selected.id)}
              >
                <Square size={12} />
                Stop
              </button>
            )}
          </div>
          <div className="terminal-panel-command">
            <span aria-hidden="true">$</span>
            <code>{selected.command}</code>
          </div>
          {selected.state === 'waiting_for_input' && selected.pty && (
            <div className="terminal-panel-hint">
              The command is waiting for input. Click the terminal and type your reply.
            </div>
          )}
          <CommandTerminal key={selected.id} session={selected} copyTextRef={copyTextRef} />
          {live && !selected.pty && <PipeInput session={selected} />}
        </div>
      )}
    </div>
  )
}
