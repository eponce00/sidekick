import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { StringDecoder } from 'string_decoder'
import type { IPty } from 'node-pty'
import type { ShellCommandResult } from '../../shared/types'
import { COMMAND_CAPTURE_BYTES } from '../../shared/terminalSessions'
import {
  credentialRedactor,
  REDACTION_STREAM_QUIET_MS,
  type CredentialRedactor
} from './credentialRedaction'
import { TERMINAL_COLUMNS, TERMINAL_ROWS } from './terminalScreen'

const WINDOWS_EXIT_MARKER = '__SIDEKICK_EXIT_CODE__='
/** Windows' console host can deliver the last output just after it reports the exit. */
const PTY_EXIT_SETTLE_MS = 150
/** How often SideKick looks whether programs a command left running have ended. */
const LEFTOVER_POLL_MS = 2_000

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Programs a command started that still run after its shell exited, such as one started with
 * Start-Process or nohup. On Windows they are the shell's descendants created since the command
 * started; on Unix the terminal's process group, given as its negative id.
 */
function leftoverProcesses(shellPid: number, since: number): Promise<number[]> {
  if (process.platform !== 'win32') return Promise.resolve(isAlive(-shellPid) ? [-shellPid] : [])
  return new Promise((resolve) => {
    let listing = ''
    const query = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Where-Object CreationDate | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $([DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds())" }'
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    query.stdout.on('data', (chunk: Buffer) => (listing += chunk.toString()))
    query.on('error', () => resolve([]))
    query.on('close', () => {
      const children = new Map<number, number[]>()
      for (const line of listing.split(/\r?\n/)) {
        const [pid, parent, created] = line.trim().split(' ').map(Number)
        // A parent id can outlive its process and be reused; only processes newer than the
        // command can be its own.
        if (!pid || !Number.isFinite(created) || created < since - 1_000) continue
        children.set(parent, [...(children.get(parent) ?? []), pid])
      }
      const found: number[] = []
      const queue = [...(children.get(shellPid) ?? [])]
      while (queue.length) {
        const pid = queue.shift()!
        found.push(pid)
        queue.push(...(children.get(pid) ?? []))
      }
      resolve(found.filter(isAlive))
    })
  })
}

function decodeCliXmlText(value: string): string {
  return value
    .replace(/_x000D__x000A_/gi, '\n')
    .replace(/_x000D_/gi, '\r')
    .replace(/_x000A_/gi, '\n')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Reduce PowerShell's serialized error stream to the human-readable error records. */
export function normalizePowerShellStderr(value: string): string {
  if (!value.includes('#< CLIXML') && !value.includes('<Objs Version=')) return value
  const errors = [...value.matchAll(/<S\s+S="Error">([\s\S]*?)<\/S>/gi)]
    .map((match) => decodeCliXmlText(match[1]).trim())
    .filter(Boolean)
  return errors.length ? [...new Set(errors)].join('\n') : ''
}

/**
 * Redacts one output stream before anything else sees it: the log file, the captured result, the
 * terminal and the run journal all receive the same redacted text. A tail that could begin a
 * stored value waits for the next chunk, or is released after a quiet moment so a prompt still
 * shows; a program that pauses mid-value on purpose can defeat that, as it could defeat any filter.
 */
function redactedOutput(
  redactor: CredentialRedactor,
  write: (chunk: string) => void
): { push: (chunk: string) => void; end: () => void } {
  const stream = redactor.stream()
  let quiet: NodeJS.Timeout | undefined
  const release = (): void => {
    if (quiet) clearTimeout(quiet)
    quiet = undefined
    const tail = stream.flush()
    if (tail) write(tail)
  }
  return {
    push: (chunk) => {
      if (quiet) clearTimeout(quiet)
      quiet = undefined
      const safe = stream.push(chunk)
      if (safe) write(safe)
      if (stream.holding) quiet = setTimeout(release, REDACTION_STREAM_QUIET_MS)
    },
    end: release
  }
}

export type PtyModule = typeof import('node-pty')
let ptyModule: Promise<PtyModule | null> | undefined

/** node-pty is native; where it cannot load, commands run over pipes as before. */
export function loadPty(): Promise<PtyModule | null> {
  ptyModule ??= import('node-pty').catch((error: unknown) => {
    console.warn('[Commands] Pseudo-terminal unavailable; commands use pipes:', error)
    return null
  })
  return ptyModule
}

/** The PowerShell wrapper that turns the command's outcome into the process exit code. */
function windowsScript(command: string, reportExitCodeOnStderr: boolean): string {
  return `& {
      $global:LASTEXITCODE = $null
      ${command}
      $sidekickSucceeded = $?
      $sidekickExitCode = $global:LASTEXITCODE
      $sidekickFinalExitCode = if ($null -ne $sidekickExitCode -and $sidekickExitCode -ne 0) {
        [int]$sidekickExitCode
      } elseif (-not $sidekickSucceeded) {
        1
      } else {
        0
      }
      ${reportExitCodeOnStderr ? `[Console]::Error.WriteLine('${WINDOWS_EXIT_MARKER}' + $sidekickFinalExitCode)` : ''}
      exit $sidekickFinalExitCode
    }`
}

/**
 * Runs a wrapped command from a file beside its log. Passing the script as an argument lets
 * Windows argv quoting corrupt commands that contain quotes (for example `node -e "..."`), which
 * could start an interactive child, report exit 0, and leave the workspace directory locked.
 * -EncodedCommand avoided that, but antivirus heuristics count it as a malware trait, as they
 * do -ExecutionPolicy Bypass, so the file is read into a script block instead of run with -File.
 */
function windowsScriptLaunch(
  outputPath: string,
  command: string,
  reportExitCodeOnStderr: boolean
): { args: string[]; scriptPath: string } {
  const scriptPath = `${outputPath}.ps1`
  writeFileSync(scriptPath, windowsScript(command, reportExitCodeOnStderr), 'utf8')
  const literal = scriptPath.replaceAll("'", "''")
  return {
    scriptPath,
    args: [
      '-Command',
      `& ([ScriptBlock]::Create([IO.File]::ReadAllText('${literal}', [Text.Encoding]::UTF8)))`
    ]
  }
}

export interface CommandRunOptions {
  process?: { file: string; args: string[] }
  id: string
  command: string
  cwd: string
  timeoutMs: number
  outputPath: string
  env?: NodeJS.ProcessEnv
  maxCaptureBytes?: number
  /** Run in a pseudo-terminal when one can be opened, so programs behave as for the user. */
  terminal?: boolean
  /** Called once the process is spawned, saying whether it got a pseudo-terminal. */
  onStart?: (info: { pty: boolean }) => void
  /**
   * Asked as the terminal's shell exits: whether to keep the command running until programs it
   * started end. Finding them takes about a second on Windows, too long for every command.
   */
  followLeftovers?: () => boolean
  onOutput?: (data: { commandId: string; chunk: string; stream: 'stdout' | 'stderr' }) => void
}

type ActiveProcess =
  | { kind: 'pipe'; child: ChildProcessWithoutNullStreams }
  | { kind: 'pty'; pty: IPty }
  /** Programs a command left running after its terminal's shell exited. */
  | { kind: 'leftovers'; pids: number[] }

export class CommandRunner {
  private readonly active = new Map<string, ActiveProcess>()
  private readonly cancelled = new Set<string>()

  constructor(private readonly redactor: CredentialRedactor = credentialRedactor) {}

  private terminate(process_: ActiveProcess, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (process_.kind === 'leftovers') {
      for (const pid of process_.pids) {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
              windowsHide: true,
              stdio: 'ignore'
            }).on('error', () => undefined)
          } else process.kill(pid, signal)
        } catch {
          // Already gone.
        }
      }
      return true
    }
    const pid = process_.kind === 'pipe' ? process_.child.pid : process_.pty.pid
    if (!pid) return false
    const killDirect = (): boolean => {
      try {
        if (process_.kind === 'pipe') return process_.child.kill(signal)
        process_.pty.kill(process.platform === 'win32' ? undefined : signal)
        return true
      } catch {
        // A rejected termination request must not escape cancellation/timer
        // callbacks, nor be interpreted as proof that the process exited.
        return false
      }
    }
    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.on('error', killDirect)
        return true
      } catch {
        return killDirect()
      }
    }
    try {
      // Unix shells can exit while a background child keeps stdout/stderr open.
      // Each command owns a process group, so terminate the complete tree
      // instead of only the shell process.
      process.kill(-pid, signal)
      return true
    } catch {
      return killDirect()
    }
  }

  /**
   * Windows has no process groups: a program the shell launched as the tree was being killed
   * survives it. Such an orphan still names the dead shell as its parent; end its tree too.
   */
  private sweepOrphans(shellPid: number | undefined): void {
    if (process.platform !== 'win32' || !shellPid) return
    try {
      spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Math.trunc(shellPid)}' | ForEach-Object { taskkill.exe /pid $_.ProcessId /t /f | Out-Null }`
        ],
        { windowsHide: true, stdio: 'ignore' }
      ).on('error', () => undefined)
    } catch {
      // Best effort: the command is already reported as stopped.
    }
  }

  cancel(id: string): boolean {
    const running = this.active.get(id)
    if (!running) return false
    this.cancelled.add(id)
    const terminated = this.terminate(running)
    const forceKillTimer = setTimeout(() => {
      if (this.active.get(id) === running) this.terminate(running, 'SIGKILL')
    }, 3_000)
    forceKillTimer.unref()
    return terminated
  }

  cancelAll(): void {
    for (const id of this.active.keys()) this.cancel(id)
  }

  isRunning(id: string): boolean {
    return this.active.has(id)
  }

  /** Types into a running command, as a user at its terminal would. */
  write(id: string, data: string): boolean {
    const running = this.active.get(id)
    if (!running) return false
    if (running.kind === 'leftovers') return false
    try {
      if (running.kind === 'pty') running.pty.write(data)
      else running.child.stdin.write(data)
      return true
    } catch {
      return false
    }
  }

  async run(options: CommandRunOptions): Promise<ShellCommandResult> {
    const pty = options.terminal && !options.process ? await loadPty() : null
    return pty ? this.runInTerminal(options, pty) : this.runOverPipes(options)
  }

  private runInTerminal(
    options: CommandRunOptions,
    ptyModule: PtyModule
  ): Promise<ShellCommandResult> {
    const maxCaptureBytes = options.maxCaptureBytes ?? COMMAND_CAPTURE_BYTES
    mkdirSync(dirname(options.outputPath), { recursive: true })
    const log = createWriteStream(options.outputPath, { flags: 'w' })
    const launch =
      process.platform === 'win32'
        ? windowsScriptLaunch(options.outputPath, options.command, false)
        : undefined
    const [file, args] = launch
      ? // Unlike the pipe path there is no -NonInteractive: a prompt here can be answered.
        ['powershell.exe', ['-NoProfile', ...launch.args]]
      : ['bash', ['-c', options.command]]
    const startedAt = Date.now()
    const terminal = ptyModule.spawn(file, args, {
      name: 'xterm-256color',
      cols: TERMINAL_COLUMNS,
      rows: TERMINAL_ROWS,
      cwd: options.cwd,
      env: {
        ...(options.env ?? process.env),
        TERM: 'xterm-256color',
        // In a terminal, git and other tools page long output and wait for a key.
        PAGER: 'cat',
        GIT_PAGER: 'cat'
      } as Record<string, string>
    })
    const running: ActiveProcess = { kind: 'pty', pty: terminal }
    this.active.set(options.id, running)
    options.onStart?.({ pty: true })

    return new Promise((resolve) => {
      let output = ''
      let capturedBytes = 0
      let truncated = false
      let timedOut = false
      let settled = false
      let forceKillTimer: NodeJS.Timeout | undefined
      let settleTimer: NodeJS.Timeout | undefined

      const out = redactedOutput(this.redactor, (chunk) => {
        log.write(chunk)
        if (!truncated) {
          const remaining = Math.max(0, maxCaptureBytes - capturedBytes)
          const bytes = Buffer.from(chunk)
          if (bytes.length > remaining) truncated = true
          const value = bytes.subarray(0, remaining).toString()
          capturedBytes += Buffer.byteLength(value)
          output += value
        }
        options.onOutput?.({ commandId: options.id, chunk, stream: 'stdout' })
      })

      const finish = (result: Omit<ShellCommandResult, 'stdout' | 'stderr'>): void => {
        if (settled) return
        out.end()
        settled = true
        clearTimeout(timer)
        if (forceKillTimer) clearTimeout(forceKillTimer)
        if (settleTimer) clearTimeout(settleTimer)
        this.active.delete(options.id)
        dataSubscription.dispose()
        exitSubscription.dispose()
        if (launch) rmSync(launch.scriptPath, { force: true })
        log.end(() => {
          resolve({
            ...result,
            stdout: output,
            stderr: '',
            commandId: options.id,
            truncated,
            outputPath: truncated ? options.outputPath : undefined,
            terminal: true
          })
        })
      }

      // What runs may change from the terminal to the programs it left running.
      const current = (): ActiveProcess => this.active.get(options.id) ?? running
      const timer = setTimeout(() => {
        timedOut = true
        this.terminate(current())
        forceKillTimer = setTimeout(() => this.terminate(current(), 'SIGKILL'), 3_000)
        settleTimer = setTimeout(
          () =>
            finish({
              success: false,
              exitCode: -1,
              error: `Command timed out after ${options.timeoutMs / 1000} seconds`
            }),
          3_500
        )
      }, options.timeoutMs)

      const dataSubscription = terminal.onData((chunk) => {
        if (settled) return
        out.push(chunk)
      })
      const exitSubscription = terminal.onExit(({ exitCode, signal }) => {
        const cancelled = !timedOut && (this.cancelled.delete(options.id) || signal === 15)
        if (cancelled || timedOut) this.sweepOrphans(terminal.pid)
        const report = (outlived: boolean): void => {
          const stopped = outlived && this.cancelled.delete(options.id)
          finish({
            success: exitCode === 0 && !timedOut && !cancelled && !stopped,
            exitCode,
            cancelled: cancelled || stopped,
            error: timedOut
              ? `Command timed out after ${options.timeoutMs / 1000} seconds`
              : cancelled || stopped
                ? 'Command cancelled'
                : undefined,
            ...(outlived ? { outlived: true } : {})
          })
        }
        setTimeout(() => {
          if (cancelled || timedOut || !options.followLeftovers?.()) return report(false)
          void this.awaitLeftovers(options.id, terminal.pid, startedAt).then(report)
        }, PTY_EXIT_SETTLE_MS)
      })
    })
  }

  /**
   * Keeps a command running while programs it started outlive its terminal's shell, so it is not
   * reported finished while they work, and Stop and the time limit still reach them. The
   * terminal closes with its shell, so what they print afterwards is lost. Says whether any did.
   */
  private async awaitLeftovers(id: string, shellPid: number, since: number): Promise<boolean> {
    const pids = await leftoverProcesses(shellPid, since)
    if (!pids.length) return false
    const leftovers: ActiveProcess = { kind: 'leftovers', pids }
    // Stopped or out of time while they were being found: that reached only the dead shell.
    if (!this.active.has(id)) {
      this.terminate(leftovers)
      return false
    }
    this.active.set(id, leftovers)
    if (this.cancelled.has(id)) this.terminate(leftovers)
    while (this.active.get(id) === leftovers && pids.some(isAlive)) {
      await new Promise((resolve) => setTimeout(resolve, LEFTOVER_POLL_MS))
    }
    return true
  }

  private runOverPipes(options: CommandRunOptions): Promise<ShellCommandResult> {
    const maxCaptureBytes = options.maxCaptureBytes ?? COMMAND_CAPTURE_BYTES
    mkdirSync(dirname(options.outputPath), { recursive: true })
    const log = createWriteStream(options.outputPath, { flags: 'w' })
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash'
    const launch =
      process.platform === 'win32' && !options.process
        ? windowsScriptLaunch(options.outputPath, options.command, true)
        : undefined
    const args = launch
      ? ['-NoProfile', '-NonInteractive', ...launch.args]
      : ['-c', options.command]
    const child = spawn(options.process?.file ?? shell, options.process?.args ?? args, {
      cwd: options.cwd,
      windowsHide: true,
      env: options.env,
      detached: process.platform !== 'win32'
    })
    const running: ActiveProcess = { kind: 'pipe', child }
    this.active.set(options.id, running)
    options.onStart?.({ pty: false })

    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let capturedBytes = 0
      let truncated = false
      let timedOut = false
      let settled = false
      let reportedWindowsExitCode: number | undefined
      let forceKillTimer: NodeJS.Timeout | undefined
      let settleTimer: NodeJS.Timeout | undefined

      const capture = (chunk: string): string => {
        const remaining = Math.max(0, maxCaptureBytes - capturedBytes)
        const bytes = Buffer.from(chunk)
        if (bytes.length > remaining) truncated = true
        const value = bytes.subarray(0, remaining).toString()
        capturedBytes += Buffer.byteLength(value)
        return value
      }
      const out = redactedOutput(this.redactor, (chunk) => {
        log.write(chunk)
        stdout += capture(chunk)
        options.onOutput?.({ commandId: options.id, chunk, stream: 'stdout' })
      })
      const err = redactedOutput(this.redactor, (chunk) => {
        log.write(chunk)
        stderr += capture(chunk)
        options.onOutput?.({ commandId: options.id, chunk, stream: 'stderr' })
      })
      // One decoder per stream: a character split between two chunks decodes whole, so a value
      // holding one is still recognised.
      const stdoutText = new StringDecoder('utf8')
      const stderrText = new StringDecoder('utf8')

      // Built only once held-back output is released, so the result holds all of it.
      const finish = (build: () => ShellCommandResult): void => {
        if (settled) return
        const restOut = stdoutText.end()
        if (restOut) out.push(restOut)
        const restErr = stderrText.end()
        if (restErr) err.push(restErr)
        out.end()
        err.end()
        const result = build()
        settled = true
        clearTimeout(timer)
        if (forceKillTimer) clearTimeout(forceKillTimer)
        if (settleTimer) clearTimeout(settleTimer)
        this.active.delete(options.id)
        if (launch) rmSync(launch.scriptPath, { force: true })
        log.end(() => {
          resolve({
            ...result,
            commandId: options.id,
            truncated,
            outputPath: truncated ? options.outputPath : undefined
          })
        })
      }

      const timer = setTimeout(() => {
        timedOut = true
        this.terminate(running)
        forceKillTimer = setTimeout(() => this.terminate(running, 'SIGKILL'), 3_000)
        settleTimer = setTimeout(
          () =>
            finish(() => ({
              success: false,
              exitCode: -1,
              stdout,
              stderr,
              error: `Command timed out after ${options.timeoutMs / 1000} seconds`
            })),
          3_500
        )
      }, options.timeoutMs)

      // A program reading input must not fail on a closed pipe; writes arrive through write().
      child.stdin?.on('error', () => undefined)
      child.stdout.on('data', (data: Buffer) => {
        if (settled) return
        const text = stdoutText.write(data)
        if (text) out.push(text)
      })
      child.stderr.on('data', (data: Buffer) => {
        if (settled) return
        const rawChunk = stderrText.write(data)
        if (!rawChunk) return
        const marker = new RegExp(`${WINDOWS_EXIT_MARKER}(-?\\d+)\\r?\\n?`, 'g')
        const matches = options.process ? [] : [...rawChunk.matchAll(marker)]
        if (matches.length) reportedWindowsExitCode = Number(matches.at(-1)?.[1])
        const chunk = options.process ? rawChunk : rawChunk.replace(marker, '')
        if (!chunk) return
        err.push(chunk)
      })
      child.on('error', (error) =>
        finish(() => ({ success: false, exitCode: -1, stdout, stderr, error: error.message }))
      )
      // Stopped as it started, the shell can die while launching a program that inherits its
      // output and outlives it, so the output never closes. A stopped shell's exit is enough.
      child.on('exit', () => {
        if (!this.cancelled.has(options.id)) return
        this.sweepOrphans(child.pid)
        settleTimer ??= setTimeout(() => {
          this.cancelled.delete(options.id)
          finish(() => ({
            success: false,
            exitCode: -1,
            stdout,
            stderr,
            cancelled: true,
            error: 'Command cancelled'
          }))
        }, 1_000)
      })
      child.on('close', (code, signal) => {
        const effectiveCode = reportedWindowsExitCode ?? code ?? -1
        const cancelled = !timedOut && (this.cancelled.delete(options.id) || signal === 'SIGTERM')
        finish(() => ({
          success: effectiveCode === 0 && !timedOut && !cancelled,
          exitCode: effectiveCode,
          stdout,
          stderr: process.platform === 'win32' ? normalizePowerShellStderr(stderr) : stderr,
          cancelled,
          error: timedOut
            ? `Command timed out after ${options.timeoutMs / 1000} seconds`
            : cancelled
              ? 'Command cancelled'
              : undefined
        }))
      })
    })
  }
}
