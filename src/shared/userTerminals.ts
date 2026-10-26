/**
 * The user's own terminals: interactive shells the user opens from the Terminal panel and types
 * into. They are kept apart from agent commands (`terminalSessions.ts`): the agent has no tool
 * that lists, reads, or writes them, and nothing the user types goes through approvals.
 */

export type UserTerminalState = 'running' | 'exited'

export interface UserTerminalSummary {
  id: string
  /** The shell's name, such as "pwsh" or "zsh". */
  title: string
  /** The shell program that was started. */
  shell: string
  /** The folder it started in. */
  cwd: string
  state: UserTerminalState
  exitCode?: number
  startedAt: number
  endedAt?: number
  /** Characters of raw output so far, the offset the next output starts at. */
  outputLength: number
}

export type UserTerminalEvent =
  | { type: 'terminal'; terminal: UserTerminalSummary }
  | { type: 'output'; id: string; offset: number; data: string }
  | { type: 'closed'; id: string }

export interface UserTerminalOutputWindow {
  id: string
  /** Where `data` starts in the terminal's raw output. */
  offset: number
  data: string
  /** Output before `offset` is no longer kept. */
  truncatedBefore: boolean
}

/** Most input a single write may carry: keystrokes or a paste, not a file. */
export const MAX_USER_TERMINAL_INPUT_LENGTH = 64 * 1024
export const MIN_USER_TERMINAL_COLUMNS = 2
export const MAX_USER_TERMINAL_COLUMNS = 500
export const MIN_USER_TERMINAL_ROWS = 1
export const MAX_USER_TERMINAL_ROWS = 300

export interface UserTerminalAPI {
  /** The user's terminals this app session, oldest first. */
  list: () => Promise<UserTerminalSummary[]>
  /**
   * Opens the user's default shell in the chat's folder, or in the home folder when the chat has
   * none. The main process resolves the folder; the window never names a path.
   */
  create: (input: {
    conversationId: string | null
    cols: number
    rows: number
  }) => Promise<UserTerminalSummary>
  /** Raw output from `offset`, as much as is still kept. */
  read: (id: string, offset?: number) => Promise<UserTerminalOutputWindow | null>
  write: (id: string, data: string) => Promise<{ written: boolean }>
  resize: (id: string, cols: number, rows: number) => Promise<{ resized: boolean }>
  /** Ends the shell and everything it started, and forgets the terminal. */
  close: (id: string) => Promise<{ closed: boolean }>
  onEvent: (callback: (event: UserTerminalEvent) => void) => () => void
}
