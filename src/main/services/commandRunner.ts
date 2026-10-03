import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createWriteStream, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { IPty } from 'node-pty'
import type { ShellCommandResult } from '../../shared/types'
import { TERMINAL_COLUMNS, TERMINAL_ROWS } from './terminalScreen'

const DEFAULT_CAPTURE_BYTES = 256 * 1024
const WINDOWS_EXIT_MARKER = '__SIDEKICK_EXIT_CODE__='
/** Windows' console host can deliver the last output just after it reports the exit. */
const PTY_EXIT_SETTLE_MS = 150

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

type PtyModule = typeof import('node-pty')
let ptyModule: Promise<PtyModule | null> | undefined

/** node-pty is native; where it cannot load, commands run over pipes as before. */
function loadPty(): Promise<PtyModule | null> {
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
  onOutput?: (data: { commandId: string; chunk: string; stream: 'stdout' | 'stderr' }) => void
}

type ActiveProcess =
  | { kind: 'pipe'; child: ChildProcessWithoutNullStreams }
  | { kind: 'pty'; pty: IPty }

export class CommandRunner {
  private readonly active = new Map<string, ActiveProcess>()
  private readonly cancelled = new Set<string>()

  private terminate(process_: ActiveProcess, signal: NodeJS.Signals = 'SIGTERM'): boolean {
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
    const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_CAPTURE_BYTES
    mkdirSync(dirname(options.outputPath), { recursive: true })
    const log = createWriteStream(options.outputPath, { flags: 'w' })
    const [file, args] =
      process.platform === 'win32'
        ? [
            'powershell.exe',
            [
              '-NoProfile',
              // EncodedCommand avoids Windows argv quoting corrupting commands that contain
              // quotes. Unlike the pipe path there is no -NonInteractive: a prompt here can
              // be answered.
              '-EncodedCommand',
              Buffer.from(windowsScript(options.command, false), 'utf16le').toString('base64')
            ]
          ]
        : ['bash', ['-c', options.command]]
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

      const finish = (result: Omit<ShellCommandResult, 'stdout' | 'stderr'>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (forceKillTimer) clearTimeout(forceKillTimer)
        if (settleTimer) clearTimeout(settleTimer)
        this.active.delete(options.id)
        dataSubscription.dispose()
        exitSubscription.dispose()
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

      const timer = setTimeout(() => {
        timedOut = true
        this.terminate(running)
        forceKillTimer = setTimeout(() => this.terminate(running, 'SIGKILL'), 3_000)
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
      const exitSubscription = terminal.onExit(({ exitCode, signal }) => {
        const cancelled = !timedOut && (this.cancelled.delete(options.id) || signal === 15)
        if (cancelled || timedOut) this.sweepOrphans(terminal.pid)
        setTimeout(
          () =>
            finish({
              success: exitCode === 0 && !timedOut && !cancelled,
              exitCode,
              cancelled,
              error: timedOut
                ? `Command timed out after ${options.timeoutMs / 1000} seconds`
                : cancelled
                  ? 'Command cancelled'
                  : undefined
            }),
          PTY_EXIT_SETTLE_MS
        )
      })
    })
  }

  private runOverPipes(options: CommandRunOptions): Promise<ShellCommandResult> {
    const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_CAPTURE_BYTES
    mkdirSync(dirname(options.outputPath), { recursive: true })
    const log = createWriteStream(options.outputPath, { flags: 'w' })
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash'
    const args =
      process.platform === 'win32'
        ? [
            '-NoProfile',
            '-NonInteractive',
            // EncodedCommand avoids Windows argv quoting corrupting commands that themselves
            // contain quotes (for example `node -e "..."`). Corruption could start an
            // interactive child, report exit 0, and leave the workspace directory locked.
            '-EncodedCommand',
            Buffer.from(windowsScript(options.command, true), 'utf16le').toString('base64')
          ]
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

      const finish = (result: ShellCommandResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (forceKillTimer) clearTimeout(forceKillTimer)
        if (settleTimer) clearTimeout(settleTimer)
        this.active.delete(options.id)
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
            finish({
              success: false,
              exitCode: -1,
              stdout,
              stderr,
              error: `Command timed out after ${options.timeoutMs / 1000} seconds`
            }),
          3_500
        )
      }, options.timeoutMs)

      // A program reading input must not fail on a closed pipe; writes arrive through write().
      child.stdin?.on('error', () => undefined)
      child.stdout.on('data', (data: Buffer) => {
        if (settled) return
        const chunk = data.toString()
        log.write(chunk)
        stdout += capture(chunk)
        options.onOutput?.({ commandId: options.id, chunk, stream: 'stdout' })
      })
      child.stderr.on('data', (data: Buffer) => {
        if (settled) return
        const rawChunk = data.toString()
        const marker = new RegExp(`${WINDOWS_EXIT_MARKER}(-?\\d+)\\r?\\n?`, 'g')
        const matches = options.process ? [] : [...rawChunk.matchAll(marker)]
        if (matches.length) reportedWindowsExitCode = Number(matches.at(-1)?.[1])
        const chunk = options.process ? rawChunk : rawChunk.replace(marker, '')
        if (!chunk) return
        log.write(chunk)
        stderr += capture(chunk)
        options.onOutput?.({ commandId: options.id, chunk, stream: 'stderr' })
      })
      child.on('error', (error) =>
        finish({ success: false, exitCode: -1, stdout, stderr, error: error.message })
      )
      // Stopped as it started, the shell can die while launching a program that inherits its
      // output and outlives it, so the output never closes. A stopped shell's exit is enough.
      child.on('exit', () => {
        if (!this.cancelled.has(options.id)) return
        this.sweepOrphans(child.pid)
        settleTimer ??= setTimeout(() => {
          this.cancelled.delete(options.id)
          finish({
            success: false,
            exitCode: -1,
            stdout,
            stderr,
            cancelled: true,
            error: 'Command cancelled'
          })
        }, 1_000)
      })
      child.on('close', (code, signal) => {
        const effectiveCode = reportedWindowsExitCode ?? code ?? -1
        const cancelled = !timedOut && (this.cancelled.delete(options.id) || signal === 'SIGTERM')
        const finalStderr =
          process.platform === 'win32' ? normalizePowerShellStderr(stderr) : stderr
        finish({
          success: effectiveCode === 0 && !timedOut && !cancelled,
          exitCode: effectiveCode,
          stdout,
          stderr: finalStderr,
          cancelled,
          error: timedOut
            ? `Command timed out after ${options.timeoutMs / 1000} seconds`
            : cancelled
              ? 'Command cancelled'
              : undefined
        })
      })
    })
  }
}
