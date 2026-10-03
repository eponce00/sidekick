/**
 * The terminal sessions of agent commands: what the chat, the Terminal panel and the agent's own
 * output tools all read, so each command has one record of what it printed and where it stands.
 */

export type TerminalSessionState =
  | 'running'
  /** Running, and its last line looks like a prompt with nothing printed since. */
  | 'waiting_for_input'
  | 'exited'
  | 'failed'
  | 'stopped'
  | 'timed_out'

export interface TerminalSessionSummary {
  /** The command's ID; for a background command, also its task ID. */
  id: string
  runId: string
  conversationId?: string
  toolCallId?: string
  title: string
  command: string
  cwd: string
  /** Runs on after its tool call returned. */
  background: boolean
  /** Runs in a pseudo-terminal, so programs behave as they would for the user. */
  pty: boolean
  state: TerminalSessionState
  exitCode?: number
  startedAt: number
  endedAt?: number
  /** Characters of raw output so far, the offset the next output starts at. */
  outputLength: number
  /** The last lines as a terminal would show them, for a one-glance view. */
  tail: string[]
}

export type TerminalSessionEvent =
  | { type: 'session'; session: TerminalSessionSummary }
  | { type: 'output'; id: string; offset: number; data: string }

export interface TerminalOutputWindow {
  id: string
  /** Where `data` starts in the session's raw output. */
  offset: number
  data: string
  /** Output before `offset` is no longer kept in memory. */
  truncatedBefore: boolean
}

export function terminalSessionIsLive(state: TerminalSessionState): boolean {
  return state === 'running' || state === 'waiting_for_input'
}

/** Most input a single write may carry: a typed line or a pasted command, not a file. */
export const MAX_TERMINAL_INPUT_LENGTH = 16 * 1024

export interface TerminalAPI {
  /** The conversation's agent commands this app session, oldest first. */
  list: (conversationId: string) => Promise<TerminalSessionSummary[]>
  /** Raw output from `offset`, as much as is still kept. */
  read: (id: string, offset?: number) => Promise<TerminalOutputWindow | null>
  /** Stops one command; the agent is told the user stopped it. */
  stop: (id: string) => Promise<{ stopped: boolean }>
  /** Stops waiting on a command and lets it run on in the background. */
  moveToBackground: (id: string) => Promise<{ moved: boolean }>
  /** Types into a running command. */
  write: (id: string, data: string) => Promise<{ written: boolean }>
  onEvent: (callback: (event: TerminalSessionEvent) => void) => () => void
}
