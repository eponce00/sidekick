import { Terminal } from '@xterm/headless'
import { credentialRedactor } from './credentialRedaction'

export const TERMINAL_COLUMNS = 160
export const TERMINAL_ROWS = 40
const SCROLLBACK_LINES = 5_000
/** Several times what the history holds, and well below what the terminal refuses to queue. */
const MAX_PENDING_CHARACTERS = 8 * 1024 * 1024

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

/**
 * A terminal with no display, fed a command's raw output, so what the model reads is what a
 * terminal would show: a progress bar is its last state, colours and cursor moves are gone, and
 * Windows' console host, which repaints with cursor positioning, still reads line by line.
 */
export class TerminalScreen {
  private readonly terminal: Terminal
  /** Output waiting for the terminal to finish the batch it is parsing. */
  private pending: string[] = []
  private pendingLength = 0
  /** Settles when the batch being parsed is on the screen. */
  private parsing?: Promise<void>
  /** The same for the pending output, made once something waits for it. */
  private next?: { promise: Promise<void>; resolve: () => void }
  private full = false
  /** Whether lines scrolled out of the history, or output was let go unparsed. */
  private lost = false

  constructor(options: { newlineIsLineBreak: boolean }) {
    this.terminal = new Terminal({
      cols: TERMINAL_COLUMNS,
      rows: TERMINAL_ROWS,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
      // A pipe's bare "\n" starts a new line at the left edge; a terminal's own output says so.
      convertEol: options.newlineIsLineBreak
    })
    // A scroll once the history is full drops its oldest line.
    this.terminal.onScroll(() => {
      const buffer = this.terminal.buffer.active
      if (buffer.type !== 'normal') return
      if (this.full) this.lost = true
      this.full = buffer.length >= TERMINAL_ROWS + SCROLLBACK_LINES
    })
  }

  /**
   * Queues output and feeds it to the terminal in batches. Written one chunk at a time, each
   * chunk waited for a timer tick, about 15 ms on Windows, so 100,000 lines took minutes.
   */
  write(data: string): Promise<void> {
    this.pending.push(data)
    this.pendingLength += data.length
    // Far more than the history holds is waiting: the oldest would only scroll out of it.
    while (this.pendingLength > MAX_PENDING_CHARACTERS && this.pending.length > 1) {
      this.pendingLength -= this.pending.shift()!.length
      this.lost = true
    }
    if (!this.parsing) this.feed()
    return this.settled()
  }

  private feed(): void {
    if (!this.pending.length) {
      this.parsing = undefined
      return
    }
    const batch = this.pending.join('')
    const done = this.next ?? deferred()
    this.pending = []
    this.pendingLength = 0
    this.next = undefined
    this.parsing = done.promise
    this.terminal.write(batch, () => {
      done.resolve()
      this.feed()
    })
  }

  /**
   * Resolves once everything written so far is on the screen, not output that arrives later: a
   * command that kept printing never let a wait for all of it end.
   */
  settled(): Promise<void> {
    if (this.pending.length) return (this.next ??= deferred()).promise
    return this.parsing ?? Promise.resolve()
  }

  /** Whether the screen no longer holds the start of the output. */
  get droppedLines(): boolean {
    return this.lost
  }

  /**
   * The screen and its scrollback as lines, a wrapped line joined back into one. The output fed in
   * is already redacted, but a console host that repaints with cursor moves can split a stored
   * value on the way in and join it again on screen, so each line is redacted once more.
   */
  lines(): string[] {
    const buffer = this.terminal.buffer.active
    const lines: string[] = []
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index)
      if (!line) continue
      const text = line.translateToString(true)
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text
      else lines.push(text)
    }
    while (lines.length && !lines.at(-1)!.trim()) lines.pop()
    return lines.map((line) => credentialRedactor.redact(line))
  }

  /**
   * The text on the cursor's line when the cursor sits after it with nothing printed since: where
   * a program that asked a question waits. Undefined when the cursor is at the start of a line.
   */
  pendingLine(): string | undefined {
    const buffer = this.terminal.buffer.active
    if (buffer.cursorX === 0) return undefined
    const text = buffer
      .getLine(buffer.baseY + buffer.cursorY)
      ?.translateToString(true)
      .trimEnd()
    return text ? credentialRedactor.redact(text) : undefined
  }

  dispose(): void {
    this.terminal.dispose()
  }
}

/**
 * Whether a line a program left the cursor on reads like a question: a confirmation, a password
 * or an interpreter prompt. Output that merely paused mid-line, such as "Compiling", does not.
 */
export function looksLikePrompt(line: string): boolean {
  const text = line.trim()
  if (!text) return false
  return (
    /[?:>\])]$/.test(text) ||
    /\b(?:y\/n|yes\/no)\b/i.test(text) ||
    /\b(?:password|passphrase|press (?:any key|enter))\b/i.test(text)
  )
}
