import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  ArrowDownToLine,
  Bot,
  Check,
  Copy,
  CornerDownLeft,
  Plus,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import {
  terminalSessionIsLive,
  type TerminalSessionSummary
} from '../../../shared/terminalSessions'
import type { UserTerminalSummary } from '../../../shared/userTerminals'
import { subscribeTerminalOutput, useTerminalSessions } from '../utils/terminalSessionStore'
import {
  addUserTerminal,
  subscribeUserTerminalOutput,
  useUserTerminals
} from '../utils/userTerminalStore'
import { copyText } from '../utils/clipboard'
import { SessionStateDot } from './SessionChip'
import { StopGlyph } from './StopGlyph'
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

function shellStateLabel(terminal: UserTerminalSummary): string {
  if (terminal.state === 'running') return 'Running'
  return terminal.exitCode ? `Exited with code ${terminal.exitCode}` : 'Exited'
}

/** The dot a row's icon carries: only a live, waiting or failed command has one. */
type RowDot = 'working' | 'waiting' | 'failed'

function sessionDot(session: TerminalSessionSummary): RowDot | undefined {
  if (session.state === 'running') return 'working'
  if (session.state === 'waiting_for_input') return 'waiting'
  if (session.state === 'timed_out' || session.state === 'failed') return 'failed'
  if (session.state === 'exited' && session.exitCode) return 'failed'
  return undefined
}

function duration(session: TerminalSessionSummary, now: number): string {
  const seconds = Math.max(0, Math.round(((session.endedAt ?? now) - session.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The last folder of a path, which is what tells commands apart; the full path is the tooltip. */
function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  )
}

/** A terminal's colours from the app's own, so it matches the light or dark theme. */
function terminalTheme(): NonNullable<ConstructorParameters<typeof Terminal>[0]>['theme'] {
  // The theme's colours are set on the body, where the app switches light and dark.
  const style = getComputedStyle(document.body)
  const token = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback
  return {
    // The panel's own surface, so the terminal is part of the panel rather than a white sheet.
    background: token('--surface-0', '#151515'),
    foreground: token('--text-primary', '#e6e6e6'),
    cursor: token('--accent', '#86aee8'),
    selectionBackground: token('--accent-subtle', 'rgba(58, 214, 184, 0.25)')
  }
}

/**
 * Opens an xterm in `host` that fits it and follows the app's theme. xterm measures its cells
 * after opening, so a fit right away can come too early and leave the terminal at its default 80
 * columns, a narrow band in a wide panel; the host's size has not changed, so the resize observer
 * would not try again. The fit is retried over the next frames.
 */
function openTerminal(
  host: HTMLElement,
  options: { convertEol: boolean }
): { terminal: Terminal; dispose: () => void } {
  const terminal = new Terminal({
    convertEol: options.convertEol,
    fontFamily: getComputedStyle(document.body).getPropertyValue('--font-mono') || 'monospace',
    // The app's code size (--code-text), so the terminal matches the command output in chat.
    fontSize: parseFloat(getComputedStyle(document.body).getPropertyValue('--code-text')) || 12,
    scrollback: 10_000,
    theme: terminalTheme(),
    // xterm's ANSI palette is tuned for black; this lifts any colour that would fall under 4.5:1
    // on the panel's surface, which matters most in the light theme.
    minimumContrastRatio: 4.5,
    allowProposedApi: true
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(host)
  /** Fits the terminal to its host; false while there is nothing to fit to yet. */
  const fitToHost = (): boolean => {
    try {
      // The fit has no size while the panel is hidden or before xterm has measured its cells.
      const size = fit.proposeDimensions()
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return false
      fit.fit()
      return true
    } catch {
      return false
    }
  }
  let measureFrame = 0
  let measureAttempts = 0
  const fitOnceMeasured = (): void => {
    if (fitToHost() || ++measureAttempts > 60) return
    measureFrame = requestAnimationFrame(fitOnceMeasured)
  }
  fitOnceMeasured()
  const observer = new ResizeObserver(() => void fitToHost())
  observer.observe(host)
  const themeObserver = new MutationObserver(() => {
    terminal.options.theme = terminalTheme()
  })
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] })
  return {
    terminal,
    dispose: () => {
      cancelAnimationFrame(measureFrame)
      observer.disconnect()
      themeObserver.disconnect()
      terminal.dispose()
    }
  }
}

/**
 * Replays output from the start and then follows it live: what arrives during the replay waits,
 * and nothing is written twice.
 */
function followOutput(
  terminal: Terminal,
  subscribe: (listener: (data: string, at: number) => void) => () => void,
  read: () => Promise<{ offset: number; data: string; truncatedBefore: boolean } | null>
): () => void {
  let offset = 0
  let replayed = false
  const pending: Array<{ data: string; at: number }> = []
  const write = (data: string, at: number): void => {
    const end = at + data.length
    if (end <= offset) return
    terminal.write(data.slice(Math.max(0, offset - at)))
    offset = end
  }
  const unsubscribe = subscribe((data, at) => {
    if (replayed) write(data, at)
    else pending.push({ data, at })
  })
  void read().then((window_) => {
    if (window_) {
      if (window_.truncatedBefore) terminal.write('\x1b[2m[earlier output not kept]\x1b[0m\r\n')
      terminal.write(window_.data)
      offset = window_.offset + window_.data.length
    }
    replayed = true
    for (const chunk of pending.splice(0)) write(chunk.data, chunk.at)
  })
  return unsubscribe
}

/**
 * A real terminal view of one agent command: its output replayed from the start, then live. A
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
    // Over pipes a bare "\n" ends a line; a pseudo-terminal says where the cursor goes.
    const { terminal, dispose } = openTerminal(host, { convertEol: !session.pty })
    terminalRef.current = terminal
    copyTextRef.current = () => {
      terminal.selectAll()
      const text = terminal.getSelection()
      terminal.clearSelection()
      return text.trimEnd()
    }
    const unsubscribe = followOutput(
      terminal,
      (listener) => subscribeTerminalOutput(session.id, listener),
      () => window.api.terminal.read(session.id, 0)
    )
    const input = terminal.onData((data) => {
      if (terminal.options.disableStdin) return
      void window.api.terminal.write(session.id, data)
    })
    return () => {
      unsubscribe()
      input.dispose()
      dispose()
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

  // The padding is on the outer frame: the fit sizes the terminal from its host's computed size,
  // which includes the host's own padding, so rows and columns would run into it.
  return (
    <div className="terminal-panel-screen">
      <div className="terminal-panel-host" ref={hostRef} />
    </div>
  )
}

/**
 * One of the user's own shells. Keystrokes go straight to it; Ctrl+C copies when text is
 * selected, as in other terminals on Windows and Linux, and interrupts otherwise.
 */
function ShellTerminal({ terminal: shell }: { terminal: UserTerminalSummary }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const running = shell.state === 'running'

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const { terminal, dispose } = openTerminal(host, { convertEol: false })
    terminalRef.current = terminal
    const unsubscribe = followOutput(
      terminal,
      (listener) => subscribeUserTerminalOutput(shell.id, listener),
      () => window.api.userTerminal.read(shell.id, 0)
    )
    const isMac = window.api.app?.platform === 'macos'
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || isMac || !event.ctrlKey || event.altKey) return true
      const key = event.key.toLowerCase()
      if (key === 'c' && !event.shiftKey && terminal.hasSelection()) {
        void copyText(terminal.getSelection())
        terminal.clearSelection()
        return false
      }
      // Paste is the browser's: xterm then receives it as typed text.
      return key !== 'v'
    })
    const input = terminal.onData((data) => {
      if (!terminal.options.disableStdin) void window.api.userTerminal.write(shell.id, data)
    })
    // The shell lays out its lines for the size it is told, so it follows the view's size.
    const resize = terminal.onResize(({ cols, rows }) => {
      void window.api.userTerminal.resize(shell.id, cols, rows)
    })
    terminal.focus()
    return () => {
      unsubscribe()
      input.dispose()
      resize.dispose()
      dispose()
      terminalRef.current = null
    }
  }, [shell.id])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.disableStdin = !running
    terminal.options.cursorBlink = running
  }, [running])

  return (
    <div className="terminal-panel-screen">
      <div className="terminal-panel-host" ref={hostRef} />
    </div>
  )
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
      <button type="submit" className="settings-secondary-action is-small">
        <CornerDownLeft size={12} />
        Send
      </button>
    </form>
  )
}

/**
 * About the size a shell will get in the panel, so its first prompt is laid out for the real
 * width; the view's fit then sets the exact size. `area` is the space the selected terminal
 * fills, or the whole panel while it is empty, which the list will share.
 */
function estimatedSize(
  area: HTMLElement | null,
  sharedWithList: boolean
): { cols: number; rows: number } {
  const box = area?.getBoundingClientRect()
  if (!box?.width || !box.height) return { cols: 80, rows: 24 }
  // The list's width in TerminalPanel.css: icons only up to 420px, else a third, 132px to 200px.
  const list = !sharedWithList
    ? 0
    : box.width <= 420
      ? 40
      : Math.min(200, Math.max(132, box.width * 0.32))
  return {
    cols: Math.max(20, Math.min(400, Math.floor((box.width - list - 24) / 7.2))),
    rows: Math.max(5, Math.min(200, Math.floor((box.height - 80) / 14)))
  }
}

const actionTitle = (label: string): { title: string; 'aria-label': string } => ({
  title: label,
  'aria-label': label
})

/**
 * The header's second line: a state dot, the status, then the folder as trailing muted text. One
 * line that ellipsizes, status first, with the whole line as its tooltip.
 */
function StatusRow({
  state,
  failed,
  dot,
  status,
  cwd
}: {
  state: string
  failed: boolean
  dot?: RowDot
  status: string
  cwd: string
}): React.JSX.Element {
  const folder = folderName(cwd)
  // A shell's last line can end in spaces ("type ... "), which read as a gap before the dot.
  const label = status.trimEnd()
  return (
    <div
      className={`terminal-panel-status is-${state}${failed ? ' is-failed' : ''}`}
      title={`${label} · ${cwd}`}
    >
      {dot && <SessionStateDot state={dot} />}
      <span className="terminal-panel-status-label">{label}</span>
      <span className="terminal-panel-status-separator" aria-hidden="true">
        ·
      </span>
      <span className="terminal-panel-cwd" title={cwd}>
        {folder}
      </span>
    </div>
  )
}

function CommandView({ session }: { session: TerminalSessionSummary }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copyTextRef = useRef<(() => string) | null>(null)
  const live = terminalSessionIsLive(session.state)
  const waitingAtTerminal = session.state === 'waiting_for_input' && session.pty
  const dot = sessionDot(session)
  return (
    <div className="terminal-panel-view">
      <div className="terminal-panel-header">
        <code className="terminal-panel-command" title={`$ ${session.command}`}>
          <span aria-hidden="true">$</span>
          {session.command}
        </code>
        <button
          type="button"
          className="settings-ghost-action is-small is-icon"
          {...actionTitle(copied ? 'Copied' : 'Copy the output')}
          onClick={() => {
            const text = copyTextRef.current?.()
            if (!text) return
            void copyText(text).then((written) => {
              if (!written) return
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1_000)
            })
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        {live && !session.background && (
          <button
            type="button"
            className="settings-ghost-action is-small is-icon"
            {...actionTitle('Run in the background, so the agent can go on')}
            onClick={() => void window.api.terminal.moveToBackground(session.id)}
          >
            <ArrowDownToLine size={14} />
          </button>
        )}
        {live && (
          <button
            type="button"
            className="settings-ghost-action is-small is-icon"
            {...actionTitle('Stop the command')}
            onClick={() => void window.api.terminal.stop(session.id)}
          >
            <StopGlyph />
          </button>
        )}
      </div>
      <StatusRow
        state={session.state}
        failed={dot === 'failed'}
        {...(dot && dot !== 'failed' ? { dot } : {})}
        status={`${stateLabel(session)}${waitingAtTerminal ? ': click the terminal and type your reply' : ''}`}
        cwd={session.cwd}
      />
      <CommandTerminal key={session.id} session={session} copyTextRef={copyTextRef} />
      {live && !session.pty && <PipeInput session={session} />}
    </div>
  )
}

function ShellView({ terminal }: { terminal: UserTerminalSummary }): React.JSX.Element {
  return (
    <div className="terminal-panel-view">
      <div className="terminal-panel-header">
        <span className="terminal-panel-shell" title={terminal.shell}>
          <SquareTerminal size={13} aria-hidden="true" />
          {terminal.title}
        </span>
        <button
          type="button"
          className="settings-ghost-action is-small is-icon is-danger"
          {...actionTitle('Kill the terminal')}
          onClick={() => void window.api.userTerminal.close(terminal.id)}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <StatusRow
        state={terminal.state}
        failed={Boolean(terminal.exitCode)}
        status={shellStateLabel(terminal)}
        cwd={terminal.cwd}
      />
      <ShellTerminal key={terminal.id} terminal={terminal} />
    </div>
  )
}

/**
 * The Terminal app, laid out like an editor's terminal panel: the selected terminal fills the
 * view, and a list beside it holds the user's own shells and the chat's agent commands.
 */
export function TerminalPanel({
  conversationId,
  requestedSessionId
}: {
  conversationId: string | null
  /** A command someone asked to see; changes select it. */
  requestedSessionId?: { id: string; at: number } | null
}): React.JSX.Element {
  const sessions = useTerminalSessions(conversationId)
  const shells = useUserTerminals()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [handledRequestAt, setHandledRequestAt] = useState(requestedSessionId?.at)
  if (requestedSessionId && requestedSessionId.at !== handledRequestAt) {
    setHandledRequestAt(requestedSessionId.at)
    setSelectedId(requestedSessionId.id)
  }
  const mainRef = useRef<HTMLDivElement>(null)
  const emptyRef = useRef<HTMLDivElement>(null)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  const anyLive = sessions.some((session) => terminalSessionIsLive(session.state))
  useEffect(() => {
    if (!anyLive) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [anyLive])

  const openShell = (): void => {
    if (opening) return
    setOpening(true)
    setOpenError(null)
    window.api.userTerminal
      .create({
        conversationId,
        ...(mainRef.current
          ? estimatedSize(mainRef.current, false)
          : estimatedSize(emptyRef.current, true))
      })
      .then((terminal) => {
        addUserTerminal(terminal)
        setSelectedId(terminal.id)
      })
      .catch((error: unknown) =>
        setOpenError(error instanceof Error ? error.message : 'The terminal could not open')
      )
      .finally(() => setOpening(false))
  }

  // Without a choice, show what is happening now: the newest running command, else the user's
  // newest shell, else the newest command.
  const selectedShell = shells.find((shell) => shell.id === selectedId)
  const selectedCommand = selectedShell
    ? undefined
    : (sessions.find((session) => session.id === selectedId) ??
      [...sessions].reverse().find((session) => terminalSessionIsLive(session.state)) ??
      (shells.length ? undefined : sessions.at(-1)))
  const shownShell = selectedShell ?? (selectedCommand ? undefined : shells.at(-1))

  const newTerminalButton = (
    <button
      type="button"
      className="terminal-panel-new"
      onClick={openShell}
      disabled={opening}
      {...actionTitle('New terminal')}
    >
      <Plus size={14} />
    </button>
  )

  if (!sessions.length && !shells.length) {
    return (
      <div className="terminal-panel-empty" ref={emptyRef}>
        <SquareTerminal size={22} aria-hidden="true" />
        <strong>No terminals yet</strong>
        <span>
          Open a shell in this chat&apos;s folder. The agent&apos;s commands show here as they run.
        </span>
        <button
          type="button"
          className="settings-secondary-action terminal-panel-empty-new"
          onClick={openShell}
        >
          <Plus size={13} />
          New terminal
        </button>
        {openError && <span className="terminal-panel-error">{openError}</span>}
      </div>
    )
  }

  const row = (
    id: string,
    item: {
      icon: React.ReactNode
      /** The row's place in its list, which the icon rail draws in place of the shared glyph. */
      numeral?: number
      title: string
      /** "name · status": the row's accessible name, steady while the row is focused. */
      summary: string
      /** How long it has run. It ticks, so it is only in the tooltip, after the summary. */
      elapsed?: string
      detail: string
      state: string
      dot?: RowDot
      /** The dot a resting row shows only in the icon rail, where it has no words to tell it apart. */
      restDot: 'idle' | 'done' | 'stopped'
      meta: string
      action?: { label: string; icon: React.ReactNode; run: () => void }
    }
  ): React.JSX.Element => {
    const selected = id === (shownShell?.id ?? selectedCommand?.id)
    return (
      <li
        key={id}
        className={`terminal-panel-item is-${item.state}${selected ? ' is-selected' : ''}`}
      >
        <button
          type="button"
          className="terminal-panel-item-select"
          onClick={() => setSelectedId(id)}
          aria-current={selected}
          aria-label={item.summary}
          title={`${item.summary}${item.elapsed ? ` · ${item.elapsed}` : ''}\n${item.detail}`}
        >
          <span className="terminal-panel-item-icon" aria-hidden="true">
            {item.icon}
            {item.numeral !== undefined && (
              <span className="terminal-panel-item-numeral">{item.numeral}</span>
            )}
            {item.dot ? (
              <SessionStateDot state={item.dot} />
            ) : (
              <span className="terminal-panel-rest-dot">
                <SessionStateDot state={item.restDot} />
              </span>
            )}
          </span>
          <span className="terminal-panel-item-title">{item.title}</span>
          <span className="terminal-panel-item-meta">{item.meta}</span>
        </button>
        {item.action && (
          <button
            type="button"
            className="terminal-panel-item-action"
            {...actionTitle(item.action.label)}
            onClick={item.action.run}
          >
            {item.action.icon}
          </button>
        )}
      </li>
    )
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-panel-main" ref={mainRef}>
        {shownShell ? (
          <ShellView terminal={shownShell} />
        ) : selectedCommand ? (
          <CommandView session={selectedCommand} />
        ) : null}
      </div>
      <aside className="terminal-panel-side">
        <div className="terminal-panel-side-head section-heading">
          <span>Terminals</span>
          {newTerminalButton}
        </div>
        {openError && <p className="terminal-panel-error">{openError}</p>}
        <div className="terminal-panel-lists">
          {shells.length > 0 && (
            <ul className="terminal-panel-list" aria-label="Your terminals">
              {shells.map((shell) =>
                row(shell.id, {
                  icon: <SquareTerminal size={13} />,
                  title: shell.title,
                  summary: `${shell.title} · ${shellStateLabel(shell)}`,
                  detail: shell.cwd,
                  state: shell.exitCode ? 'failed' : shell.state,
                  // An open shell is its resting state, so only a failed one carries a dot.
                  ...(shell.exitCode ? { dot: 'failed' as const } : {}),
                  restDot: shell.state === 'running' ? 'idle' : 'done',
                  meta: shell.state === 'running' ? '' : `Exit ${shell.exitCode ?? 0}`,
                  action: {
                    label: `Kill ${shell.title}`,
                    icon: <Trash2 size={12} />,
                    run: () => void window.api.userTerminal.close(shell.id)
                  }
                })
              )}
            </ul>
          )}
          {sessions.length > 0 && (
            <>
              <div className="terminal-panel-group">Agent</div>
              <ul className="terminal-panel-list" aria-label="Agent commands">
                {[...sessions].reverse().map((session, index) =>
                  row(session.id, {
                    icon: <Bot size={13} />,
                    numeral: index + 1,
                    title: session.title,
                    summary: `${session.title} · ${stateLabel(session)}`,
                    elapsed: duration(session, now),
                    detail: session.command,
                    dot: sessionDot(session),
                    restDot: session.state === 'stopped' ? 'stopped' : 'done',
                    state:
                      session.state === 'exited' && session.exitCode ? 'failed' : session.state,
                    meta:
                      session.state === 'waiting_for_input'
                        ? 'Needs input'
                        : session.state === 'exited' && session.exitCode
                          ? `Exit ${session.exitCode}`
                          : duration(session, now),
                    ...(terminalSessionIsLive(session.state)
                      ? {
                          action: {
                            label: `Stop ${session.title}`,
                            icon: <StopGlyph size={9} />,
                            run: () => void window.api.terminal.stop(session.id)
                          }
                        }
                      : {})
                  })
                )}
              </ul>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}
