import { Terminal } from '@xterm/headless'
import { credentialRedactor } from './credentialRedaction'

export const TERMINAL_COLUMNS = 160
export const TERMINAL_ROWS = 40
const SCROLLBACK_LINES = 5_000

/**
 * A terminal with no display, fed a command's raw output, so what the model reads is what a
 * terminal would show: a progress bar is its last state, colours and cursor moves are gone, and
 * Windows' console host, which repaints with cursor positioning, still reads line by line.
 */
export class TerminalScreen {
  private readonly terminal: Terminal
  private written: Promise<void> = Promise.resolve()

  constructor(options: { newlineIsLineBreak: boolean }) {
    this.terminal = new Terminal({
      cols: TERMINAL_COLUMNS,
      rows: TERMINAL_ROWS,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
      // A pipe's bare "\n" starts a new line at the left edge; a terminal's own output says so.
      convertEol: options.newlineIsLineBreak
    })
  }

  write(data: string): Promise<void> {
    this.written = this.written.then(
      () => new Promise<void>((resolve) => this.terminal.write(data, resolve))
    )
    return this.written
  }

  /** Resolves once everything written so far is on the screen. */
  settled(): Promise<void> {
    return this.written
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
