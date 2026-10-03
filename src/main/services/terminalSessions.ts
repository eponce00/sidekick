import {
  terminalSessionIsLive,
  type TerminalOutputWindow,
  type TerminalSessionEvent,
  type TerminalSessionState,
  type TerminalSessionSummary
} from '../../shared/terminalSessions'
import { looksLikePrompt, TerminalScreen } from './terminalScreen'

/** Raw output kept per session for the Terminal panel to replay; the full log is on disk. */
const MAX_RAW_CHARACTERS = 1_000_000
const MAX_SESSIONS = 100
const TAIL_LINES = 6
const TAIL_THROTTLE_MS = 200
const PROMPT_IDLE_MS = 5_000

export interface StartTerminalSessionInput {
  id: string
  runId: string
  conversationId?: string
  toolCallId?: string
  title: string
  command: string
  cwd: string
  background: boolean
  pty: boolean
}

export interface TerminalModelRead {
  id: string
  state: TerminalSessionState
  exitCode?: number
  text: string
  /** Lines the read had to leave out to stay within its limit. */
  omittedLines: number
  totalLines: number
}

interface SessionRecord {
  summary: TerminalSessionSummary
  chunks: string[]
  /** Offset of the first character still in `chunks`. */
  rawStart: number
  /** Live until the command ends, then replaced by its final lines. */
  screen?: TerminalScreen
  finalLines?: string[]
  /** Rendered lines the agent has already read. */
  agentReadLines: number
  tailTimer?: NodeJS.Timeout
  idleTimer?: NodeJS.Timeout
}

/**
 * Every agent command's terminal: its raw output for display, its rendered text for the model,
 * and its state, published as it changes. One record serves the chat, the Terminal panel and
 * the agent's own output tools, so they never disagree about what a command printed.
 */
export class TerminalSessionStore {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly stateListeners = new Set<(session: TerminalSessionSummary) => void>()
  private readonly outputListeners = new Set<(id: string, data: string) => void>()

  constructor(
    private readonly publish: (event: TerminalSessionEvent) => void = () => undefined,
    private readonly promptIdleMs = PROMPT_IDLE_MS
  ) {}

  /** Called whenever a session's state changes, for whoever must act on a waiting prompt. */
  onStateChange(listener: (session: TerminalSessionSummary) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** Called with each piece of raw output, for whoever waits for a command to print something. */
  onOutput(listener: (id: string, data: string) => void): () => void {
    this.outputListeners.add(listener)
    return () => this.outputListeners.delete(listener)
  }

  start(input: StartTerminalSessionInput): TerminalSessionSummary {
    const summary: TerminalSessionSummary = {
      ...input,
      state: 'running',
      startedAt: Date.now(),
      outputLength: 0,
      tail: []
    }
    this.sessions.set(input.id, {
      summary,
      chunks: [],
      rawStart: 0,
      // Pipes end lines with a bare "\n"; a pseudo-terminal says where the cursor goes.
      screen: new TerminalScreen({ newlineIsLineBreak: !input.pty }),
      agentReadLines: 0
    })
    this.evict()
    this.announce(input.id)
    return { ...summary }
  }

  append(id: string, data: string): void {
    const record = this.sessions.get(id)
    if (!record || !data) return
    const offset = record.summary.outputLength
    record.chunks.push(data)
    record.summary.outputLength += data.length
    let kept = record.summary.outputLength - record.rawStart
    while (kept > MAX_RAW_CHARACTERS && record.chunks.length > 1) {
      const dropped = record.chunks.shift()!
      record.rawStart += dropped.length
      kept -= dropped.length
    }
    void record.screen?.write(data)
    this.publish({ type: 'output', id, offset, data })
    for (const listener of this.outputListeners) listener(id, data)
    if (record.summary.state === 'waiting_for_input') this.setState(record, 'running')
    this.scheduleTail(record)
    this.watchForPrompt(record)
  }

  /** Marks a foreground command as running on after its tool call returned. */
  moveToBackground(id: string): void {
    const record = this.sessions.get(id)
    if (!record || record.summary.background) return
    record.summary.background = true
    this.announce(id)
  }

  async finish(
    id: string,
    outcome: {
      state: Exclude<TerminalSessionState, 'running' | 'waiting_for_input'>
      exitCode?: number
    }
  ): Promise<void> {
    const record = this.sessions.get(id)
    if (!record || !terminalSessionIsLive(record.summary.state)) return
    clearTimeout(record.idleTimer)
    clearTimeout(record.tailTimer)
    if (record.screen) {
      await record.screen.settled()
      record.finalLines = record.screen.lines()
      record.screen.dispose()
      record.screen = undefined
    }
    record.summary.state = outcome.state
    record.summary.exitCode = outcome.exitCode
    record.summary.endedAt = Date.now()
    record.summary.tail = (record.finalLines ?? []).slice(-TAIL_LINES)
    this.announce(id)
    this.notifyState(record)
  }

  get(id: string): TerminalSessionSummary | undefined {
    const record = this.sessions.get(id)
    return record ? { ...record.summary, tail: [...record.summary.tail] } : undefined
  }

  list(conversationId?: string): TerminalSessionSummary[] {
    return [...this.sessions.values()]
      .filter((record) => !conversationId || record.summary.conversationId === conversationId)
      .map((record) => ({ ...record.summary, tail: [...record.summary.tail] }))
      .sort((left, right) => left.startedAt - right.startedAt)
  }

  /** Raw output from `offset`, as much as is still kept, for a terminal view to replay. */
  read(id: string, offset = 0): TerminalOutputWindow | undefined {
    const record = this.sessions.get(id)
    if (!record) return undefined
    const all = record.chunks.join('')
    const start = Math.max(offset, record.rawStart)
    return {
      id,
      offset: start,
      data: all.slice(start - record.rawStart),
      truncatedBefore: start > offset
    }
  }

  /** The output as a terminal shows it, once everything written so far is rendered. */
  async lines(id: string): Promise<string[] | undefined> {
    const record = this.sessions.get(id)
    if (!record) return undefined
    if (record.finalLines) return record.finalLines
    await record.screen?.settled()
    return record.finalLines ?? record.screen?.lines() ?? []
  }

  /**
   * What the agent reads of a command: by default what it printed since the agent last looked,
   * or its latest lines, optionally only those matching a pattern.
   */
  async readForModel(
    id: string,
    options: { mode?: 'new' | 'tail'; maxLines?: number; pattern?: RegExp } = {}
  ): Promise<TerminalModelRead | undefined> {
    const record = this.sessions.get(id)
    const all = await this.lines(id)
    if (!record || !all) return undefined
    const maxLines = Math.max(1, Math.min(400, options.maxLines ?? 80))
    // A screen that scrolled past its history no longer lines up with the last read.
    const from =
      options.mode === 'tail' || record.agentReadLines > all.length ? 0 : record.agentReadLines
    let selected = all.slice(from)
    if (options.pattern) selected = selected.filter((line) => options.pattern!.test(line))
    const omittedLines = Math.max(0, selected.length - maxLines)
    record.agentReadLines = all.length
    return {
      id,
      state: record.summary.state,
      exitCode: record.summary.exitCode,
      text: selected.slice(-maxLines).join('\n'),
      omittedLines,
      totalLines: all.length
    }
  }

  private setState(record: SessionRecord, state: TerminalSessionState): void {
    if (record.summary.state === state) return
    record.summary.state = state
    this.announce(record.summary.id)
    this.notifyState(record)
  }

  private notifyState(record: SessionRecord): void {
    for (const listener of this.stateListeners) listener({ ...record.summary })
  }

  /** A program that printed a question and then went quiet is waiting for an answer. */
  private watchForPrompt(record: SessionRecord): void {
    clearTimeout(record.idleTimer)
    record.idleTimer = setTimeout(() => {
      const screen = record.screen
      if (!screen || record.summary.state !== 'running') return
      void screen.settled().then(() => {
        const line = screen.pendingLine()
        if (record.summary.state === 'running' && line && looksLikePrompt(line)) {
          this.setState(record, 'waiting_for_input')
        }
      })
    }, this.promptIdleMs)
    record.idleTimer.unref?.()
  }

  private scheduleTail(record: SessionRecord): void {
    if (record.tailTimer) return
    record.tailTimer = setTimeout(() => {
      record.tailTimer = undefined
      const screen = record.screen
      if (!screen) return
      void screen.settled().then(() => {
        if (record.screen !== screen) return
        record.summary.tail = screen.lines().slice(-TAIL_LINES)
        this.announce(record.summary.id)
      })
    }, TAIL_THROTTLE_MS)
    record.tailTimer.unref?.()
  }

  private announce(id: string): void {
    const session = this.get(id)
    if (session) this.publish({ type: 'session', session })
  }

  /** Forgets the oldest finished sessions; a running one is never dropped. */
  private evict(): void {
    if (this.sessions.size <= MAX_SESSIONS) return
    for (const [id, record] of this.sessions) {
      if (this.sessions.size <= MAX_SESSIONS) break
      if (terminalSessionIsLive(record.summary.state)) continue
      this.sessions.delete(id)
    }
  }
}
