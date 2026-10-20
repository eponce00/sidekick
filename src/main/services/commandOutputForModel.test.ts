import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { commandOutputForModel } from './commandOutputForModel'
import { ToolOutputStore } from './toolOutputStore'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function store(): Promise<ToolOutputStore> {
  const root = await fs.mkdtemp(join(tmpdir(), 'sidekick-command-output-'))
  roots.push(root)
  return new ToolOutputStore(root)
}

/** What an FTP download script printed in the transcript that prompted this format. */
function transferLog(lines: number): string {
  return Array.from(
    { length: lines },
    (_, line) => `200 RETR block ${String(line).padStart(5, '0')}: 4096 bytes "OK"\\done`
  )
    .join('\r\n')
    .concat('\r\n')
}

describe('commandOutputForModel', () => {
  it('shows each stream as plain text under a short header, with nothing escaped', async () => {
    const outputs = await store()
    const bounded = await commandOutputForModel(outputs, {
      success: false,
      exitCode: 2,
      stdout: 'Connected to "cell-7"\nDownloaded 3 files\n',
      stderr: 'warning: C:\\robot\\job.ls is read-only\n'
    })

    expect(bounded.content).toBe(
      'Exit code: 2\n' +
        '<stdout>\nConnected to "cell-7"\nDownloaded 3 files\n</stdout>\n' +
        '<stderr>\nwarning: C:\\robot\\job.ls is read-only\n</stderr>\n'
    )
    expect(bounded.output.truncated).toBe(false)
  })

  it('says how a command ended and leaves out empty streams', async () => {
    const outputs = await store()
    const timedOut = await commandOutputForModel(outputs, {
      success: false,
      exitCode: -1,
      stdout: '',
      stderr: '',
      cancelled: true,
      error: 'Command timed out after 30 seconds'
    })
    expect(timedOut.content).toBe(
      'Exit code: -1\nThe command was cancelled before it finished.\n' +
        'Error: Command timed out after 30 seconds\nNo output.\n'
    )
    const terminal = await commandOutputForModel(outputs, {
      success: true,
      exitCode: 0,
      stdout: 'PS> ok',
      stderr: '',
      terminal: true
    })
    expect(terminal.content).toBe('Exit code: 0\n<output>\nPS> ok\n</output>\n')
  })

  it('cuts a long stream on whole lines and says SideKick shortened it, not the command', async () => {
    // An agent read SideKick's cut copy of a download as the file and concluded that its FTP
    // reads were truncating; the same command then fetched the whole 2.4 MB file.
    const outputs = await store()
    const stdout = transferLog(6_000)
    const bounded = await commandOutputForModel(outputs, {
      success: true,
      exitCode: 0,
      stdout,
      stderr: ''
    })

    expect(bounded.output.truncated).toBe(true)
    expect(bounded.output.returnedEstimatedTokens).toBeLessThanOrEqual(8_192)
    expect(bounded.content).not.toContain('\\n')
    expect(bounded.content).toContain('block 00000: 4096 bytes "OK"\\done\r\n')
    expect(bounded.content).toContain('block 05999: 4096 bytes "OK"\\done\r\n</stdout>\n')
    const note = /\[… (.+) …\]/.exec(bounded.content)?.[1] ?? ''
    expect(note).toMatch(
      /^SideKick shortened the output shown in the chat: [\d,]+ lines \([\d,]+ bytes\) of stdout left out here\. The command's own output was complete\. Read the part left out with tool_output, handle "[0-9a-f-]{36}" and offset \d+\.$/
    )
    // Every line the model sees is a whole line of the output.
    for (const line of bounded.content.split('\n').slice(2, -3)) {
      if (!line.startsWith('[…')) expect(line).toMatch(/^200 RETR block \d{5}: .*\r$/)
    }

    const offset = Number(/offset (\d+)\./.exec(note)?.[1])
    const handle = bounded.output.fullOutputHandle!
    const shown = bounded.content.split('\n[…')[0]
    const lastShown = Number(/block (\d{5})/.exec(shown.split('\n').at(-1) ?? '')?.[1])
    const rest = await outputs.read(handle, offset, 1_024)
    expect(rest.content.startsWith(`200 RETR block ${String(lastShown + 1).padStart(5, '0')}`)).toBe(
      true
    )
  })

  it('does not call output complete when SideKick kept only part of what was printed', async () => {
    const outputs = await store()
    const bounded = await commandOutputForModel(outputs, {
      success: true,
      exitCode: 0,
      stdout: transferLog(6_000),
      stderr: '',
      truncated: true
    })
    expect(bounded.content).toContain(
      'The command printed more than 256 KB; SideKick kept only the first 256 KB.'
    )
    expect(bounded.content).not.toContain("The command's own output was complete")
  })
})
