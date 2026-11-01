import { spawn as spawnProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, statSync } from 'fs'
import { homedir, userInfo } from 'os'
import { basename, delimiter, join } from 'path'
import type { IPty } from 'node-pty'
import {
  MAX_USER_TERMINAL_COLUMNS,
  MAX_USER_TERMINAL_INPUT_LENGTH,
  MAX_USER_TERMINAL_ROWS,
  MIN_USER_TERMINAL_COLUMNS,
  MIN_USER_TERMINAL_ROWS,
  type UserTerminalEvent,
  type UserTerminalOutputWindow,
  type UserTerminalSummary
} from '../../shared/userTerminals'
import { loadPty } from './commandRunner'

/** Raw output kept per terminal for a view to replay when it opens. */
const MAX_RAW_CHARACTERS = 1_000_000
/** Terminals kept at once, running or exited; enough for any real use, bounded for a bad caller. */
const MAX_TERMINALS = 32

type Spawn = (
  file: string,
  args: string[],
  options: { cwd: string; cols: number; rows: number; env: Record<string, string> }
) => IPty

export interface UserTerminalServiceOptions {
  publish?: (event: UserTerminalEvent) => void
  /** The chat's folder, from the main process's own records; null when it has none. */
  folderFor?: (conversationId: string) => string | null
  /** Opens a pseudo-terminal; node-pty unless a test gives another. */
  spawn?: Spawn
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

interface TerminalRecord {
  summary: UserTerminalSummary
  pty: IPty
  chunks: string[]
  /** Offset of the first character still in `chunks`. */
  rawStart: number
}

function onPath(program: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const folder of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!folder) continue
    const candidate = join(folder, program)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * The shell a terminal app would open: PowerShell 7 on Windows when installed, else Windows
 * PowerShell; the login shell elsewhere, as a login shell on macOS like Terminal.app.
 */
export function defaultShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): { file: string; args: string[] } {
  if (platform === 'win32') {
    return { file: onPath('pwsh.exe', env) ?? 'powershell.exe', args: ['-NoLogo'] }
  }
  let account: string | undefined
  try {
    account = userInfo().shell ?? undefined
  } catch {
    account = undefined
  }
  const file = env.SHELL || account || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return { file, args: platform === 'darwin' ? ['-l'] : [] }
}

/** The user's own environment, without what only matters to SideKick's Electron process. */
export function userShellEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || name.startsWith('ELECTRON_') || name.startsWith('SIDEKICK_E2E'))
      continue
    env[name] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'SideKick'
  return env
}

function bounded(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined
}

function isFolder(path: string | null | undefined): path is string {
  try {
    return Boolean(path) && statSync(path!).isDirectory()
  } catch {
    return false
  }
}

/**
 * The user's own shells. Each is an interactive pseudo-terminal the user types into; it is not an
 * agent command, so nothing here goes through permissions, and the agent's runtime holds no
 * reference to this service: it cannot list, read, or type into these terminals.
 */
export class UserTerminalService {
  private readonly terminals = new Map<string, TerminalRecord>()
  private readonly publish: (event: UserTerminalEvent) => void
  private readonly folderFor: (conversationId: string) => string | null
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly spawnPty?: Spawn

  constructor(options: UserTerminalServiceOptions = {}) {
    this.publish = options.publish ?? (() => undefined)
    this.folderFor = options.folderFor ?? (() => null)
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
    this.spawnPty = options.spawn
  }

  private async spawner(): Promise<Spawn> {
    if (this.spawnPty) return this.spawnPty
    const pty = await loadPty()
    if (!pty) throw new Error('Terminals are unavailable: the pseudo-terminal could not load')
    return (file, args, options) => pty.spawn(file, args, { name: 'xterm-256color', ...options })
  }

  list(): UserTerminalSummary[] {
    return [...this.terminals.values()]
      .map((record) => ({ ...record.summary }))
      .sort((left, right) => left.startedAt - right.startedAt)
  }

  /** Where a new terminal starts: the chat's folder when it still exists, else the home folder. */
  startFolder(conversationId: string | null): string {
    let folder: string | null = null
    if (conversationId) {
      try {
        folder = this.folderFor(conversationId)
      } catch {
        folder = null
      }
    }
    return isFolder(folder) ? folder : homedir()
  }

  async create(input: {
    conversationId: string | null
    cols?: unknown
    rows?: unknown
  }): Promise<UserTerminalSummary> {
    const spawn = await this.spawner()
    if (this.terminals.size >= MAX_TERMINALS)
      throw new Error('Close a terminal before opening another')
    const cols = bounded(input.cols, MIN_USER_TERMINAL_COLUMNS, MAX_USER_TERMINAL_COLUMNS) ?? 80
    const rows = bounded(input.rows, MIN_USER_TERMINAL_ROWS, MAX_USER_TERMINAL_ROWS) ?? 24
    const cwd = this.startFolder(input.conversationId)
    const shell = defaultShell(this.platform, this.env)
    const pty = spawn(shell.file, shell.args, {
      cwd,
      cols,
      rows,
      env: userShellEnvironment(this.env)
    })
    const id = randomUUID()
    const record: TerminalRecord = {
      summary: {
        id,
        title: basename(shell.file).replace(/\.exe$/i, ''),
        shell: shell.file,
        cwd,
        state: 'running',
        startedAt: Date.now(),
        outputLength: 0
      },
      pty,
      chunks: [],
      rawStart: 0
    }
    this.terminals.set(id, record)
    pty.onData((data) => this.append(record, data))
    pty.onExit(({ exitCode }) => {
      if (this.terminals.get(id) !== record) return
      record.summary.state = 'exited'
      record.summary.exitCode = exitCode
      record.summary.endedAt = Date.now()
      this.announce(record)
    })
    this.announce(record)
    return { ...record.summary }
  }

  private append(record: TerminalRecord, data: string): void {
    if (!data || this.terminals.get(record.summary.id) !== record) return
    const offset = record.summary.outputLength
    record.chunks.push(data)
    record.summary.outputLength += data.length
    let kept = record.summary.outputLength - record.rawStart
    while (kept > MAX_RAW_CHARACTERS && record.chunks.length > 1) {
      const dropped = record.chunks.shift()!
      record.rawStart += dropped.length
      kept -= dropped.length
    }
    this.publish({ type: 'output', id: record.summary.id, offset, data })
  }

  read(id: string, offset = 0): UserTerminalOutputWindow | undefined {
    const record = this.terminals.get(id)
    if (!record) return undefined
    const start = Math.max(offset, record.rawStart)
    return {
      id,
      offset: start,
      data: record.chunks.join('').slice(start - record.rawStart),
      truncatedBefore: start > offset
    }
  }

  write(id: string, data: unknown): boolean {
    const record = this.terminals.get(id)
    if (
      !record ||
      record.summary.state !== 'running' ||
      typeof data !== 'string' ||
      !data.length ||
      data.length > MAX_USER_TERMINAL_INPUT_LENGTH
    )
      return false
    try {
      record.pty.write(data)
      return true
    } catch {
      return false
    }
  }

  resize(id: string, cols: unknown, rows: unknown): boolean {
    const record = this.terminals.get(id)
    const columns = bounded(cols, MIN_USER_TERMINAL_COLUMNS, MAX_USER_TERMINAL_COLUMNS)
    const lines = bounded(rows, MIN_USER_TERMINAL_ROWS, MAX_USER_TERMINAL_ROWS)
    if (!record || record.summary.state !== 'running' || !columns || !lines) return false
    try {
      record.pty.resize(columns, lines)
      return true
    } catch {
      return false
    }
  }

  /** Ends the shell with everything it started, and forgets the terminal. */
  close(id: string): boolean {
    const record = this.terminals.get(id)
    if (!record) return false
    this.terminals.delete(id)
    if (record.summary.state === 'running') this.terminate(record.pty)
    this.publish({ type: 'closed', id })
    return true
  }

  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id)
  }

  /**
   * Windows has no hang-up signal for a console, so the shell's tree is ended; elsewhere a hang-up
   * is what closing a terminal window sends, and the shell passes it on to its jobs.
   */
  private terminate(pty: IPty): void {
    if (this.platform === 'win32' && pty.pid) {
      try {
        spawnProcess('taskkill.exe', ['/pid', String(pty.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore'
        }).on('error', () => undefined)
      } catch {
        // The pty is killed below either way.
      }
    }
    try {
      pty.kill(this.platform === 'win32' ? undefined : 'SIGHUP')
    } catch {
      // Already gone.
    }
  }

  private announce(record: TerminalRecord): void {
    this.publish({ type: 'terminal', terminal: { ...record.summary } })
  }
}
