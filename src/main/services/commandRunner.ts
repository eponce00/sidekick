import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createWriteStream, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { ShellCommandResult } from '../../shared/types'

const DEFAULT_CAPTURE_BYTES = 256 * 1024
const WINDOWS_EXIT_MARKER = '__SIDEKICK_EXIT_CODE__='

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

export interface CommandRunOptions {
  id: string
  command: string
  cwd: string
  timeoutMs: number
  outputPath: string
  env?: NodeJS.ProcessEnv
  maxCaptureBytes?: number
  onOutput?: (data: { commandId: string; chunk: string; stream: 'stdout' | 'stderr' }) => void
}

export class CommandRunner {
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>()
  private readonly cancelled = new Set<string>()

  private terminate(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals = 'SIGTERM'
  ): boolean {
    if (!child.pid) return false
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.on('error', () => child.kill(signal))
      return true
    }
    try {
      // Unix shells can exit while a background child keeps stdout/stderr open.
      // Each command owns a detached process group, so terminate the complete
      // tree instead of only the shell process.
      process.kill(-child.pid, signal)
      return true
    } catch {
      return child.kill(signal)
    }
  }

  cancel(id: string): boolean {
    const child = this.active.get(id)
    if (!child) return false
    this.cancelled.add(id)
    const terminated = this.terminate(child)
    const forceKillTimer = setTimeout(() => {
      if (this.active.get(id) === child) this.terminate(child, 'SIGKILL')
    }, 3_000)
    forceKillTimer.unref()
    return terminated
  }

  cancelAll(): void {
    for (const id of this.active.keys()) this.cancel(id)
  }

  run(options: CommandRunOptions): Promise<ShellCommandResult> {
    const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_CAPTURE_BYTES
    mkdirSync(dirname(options.outputPath), { recursive: true })
    const log = createWriteStream(options.outputPath, { flags: 'w' })
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash'
    const windowsCommand = `& {
      $global:LASTEXITCODE = $null
      ${options.command}
      $sidekickSucceeded = $?
      $sidekickExitCode = $global:LASTEXITCODE
      $sidekickFinalExitCode = if ($null -ne $sidekickExitCode -and $sidekickExitCode -ne 0) {
        [int]$sidekickExitCode
      } elseif (-not $sidekickSucceeded) {
        1
      } else {
        0
      }
      [Console]::Error.WriteLine('${WINDOWS_EXIT_MARKER}' + $sidekickFinalExitCode)
      exit $sidekickFinalExitCode
    }`
    const args =
      process.platform === 'win32'
        ? [
            '-NoProfile',
            '-NonInteractive',
            // EncodedCommand avoids Windows argv quoting corrupting commands that themselves
            // contain quotes (for example `node -e "..."`). Corruption could start an
            // interactive child, report exit 0, and leave the workspace directory locked.
            '-EncodedCommand',
            Buffer.from(windowsCommand, 'utf16le').toString('base64')
          ]
        : ['-c', options.command]
    const child = spawn(shell, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: options.env,
      detached: process.platform !== 'win32'
    })
    this.active.set(options.id, child)

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
        this.terminate(child)
        forceKillTimer = setTimeout(() => this.terminate(child, 'SIGKILL'), 3_000)
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

      child.stdout.on('data', (data: Buffer) => {
        if (settled) return
        const chunk = data.toString()
        log.write(`[stdout]\n${chunk}`)
        stdout += capture(chunk)
        options.onOutput?.({ commandId: options.id, chunk, stream: 'stdout' })
      })
      child.stderr.on('data', (data: Buffer) => {
        if (settled) return
        const rawChunk = data.toString()
        const marker = new RegExp(`${WINDOWS_EXIT_MARKER}(-?\\d+)\\r?\\n?`, 'g')
        const matches = [...rawChunk.matchAll(marker)]
        if (matches.length) reportedWindowsExitCode = Number(matches.at(-1)?.[1])
        const chunk = rawChunk.replace(marker, '')
        if (!chunk) return
        log.write(`[stderr]\n${chunk}`)
        stderr += capture(chunk)
        options.onOutput?.({ commandId: options.id, chunk, stream: 'stderr' })
      })
      child.on('error', (error) =>
        finish({ success: false, exitCode: -1, stdout, stderr, error: error.message })
      )
      child.on('close', (code, signal) => {
        const effectiveCode = reportedWindowsExitCode ?? code ?? -1
        const cancelled = !timedOut && (this.cancelled.delete(options.id) || signal === 'SIGTERM')
        const finalStderr =
          process.platform === 'win32' ? normalizePowerShellStderr(stderr) : stderr
        finish({
          success: effectiveCode === 0 && !timedOut,
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
