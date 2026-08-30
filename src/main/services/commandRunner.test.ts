import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandRunner, normalizePowerShellStderr } from './commandRunner'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    })
  }
})

describe('CommandRunner', () => {
  it('extracts useful PowerShell errors from CLIXML noise', () => {
    const serialized =
      '#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress"><S>Preparing modules</S></Obj><S S="Error">At line:3 char:4_x000D__x000A_Missing ] at end of attribute.&lt;bad&gt;</S></Objs>'

    expect(normalizePowerShellStderr(serialized)).toBe(
      'At line:3 char:4\nMissing ] at end of attribute.<bad>'
    )
  })

  it('captures bounded output and preserves the full log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sidekick-command-'))
    tempDirs.push(dir)
    const outputPath = join(dir, 'output.log')
    const command =
      process.platform === 'win32'
        ? "[Console]::Out.Write('abcdefghijklmnop')"
        : "printf 'abcdefghijklmnop'"
    const result = await new CommandRunner().run({
      id: 'bounded',
      command,
      cwd: dir,
      timeoutMs: 5000,
      outputPath,
      maxCaptureBytes: 8
    })
    expect(result.success).toBe(true)
    expect(result.stdout).toBe('abcdefgh')
    expect(result.truncated).toBe(true)
    expect(result.outputPath).toBe(outputPath)
    expect(readFileSync(outputPath, 'utf8')).toContain('abcdefghijklmnop')
  })

  it('cancels a running command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sidekick-command-'))
    tempDirs.push(dir)
    const runner = new CommandRunner()
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30'
    const pending = runner.run({
      id: 'cancelled',
      command,
      cwd: dir,
      timeoutMs: 10_000,
      outputPath: join(dir, 'cancelled.log')
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(runner.cancel('cancelled')).toBe(true)
    const result = await pending
    expect(result.cancelled).toBe(true)
    expect(result.success).toBe(false)
    expect(result.error).toBe('Command cancelled')
  })

  it.runIf(process.platform === 'win32')(
    'preserves the exit code from a failing native Windows command',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sidekick-command-'))
      tempDirs.push(dir)
      const result = await new CommandRunner().run({
        id: 'native-exit-code',
        command: 'cmd.exe /d /c exit 7',
        cwd: dir,
        timeoutMs: 5_000,
        outputPath: join(dir, 'native-exit-code.log')
      })
      expect(result.success).toBe(false)
      expect(result.exitCode).toBe(7)
    }
  )

  it.runIf(process.platform !== 'win32')(
    'times out a shell and its background process tree',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sidekick-command-'))
      tempDirs.push(dir)
      const startedAt = Date.now()
      const result = await new CommandRunner().run({
        id: 'background-timeout',
        command: 'sleep 30 &',
        cwd: dir,
        timeoutMs: 150,
        outputPath: join(dir, 'background-timeout.log')
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Command timed out after 0.15 seconds')
      expect(Date.now() - startedAt).toBeLessThan(2_000)
    }
  )
})
