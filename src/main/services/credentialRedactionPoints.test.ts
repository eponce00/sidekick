/**
 * Every place tool output leaves a tool redacts stored credential values: the command runner at
 * the source of its streams, the retained-output store before it measures or writes, the tool
 * registry for every result including failures, and the provider boundary for every request.
 */
import { randomBytes } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { materializeProviderRequestMedia } from '../providers/providerRuntime'
import { CommandRunner } from './commandRunner'
import { CredentialRedactor, credentialRedactor } from './credentialRedaction'
import { AgentToolRegistry } from './agentToolRegistry'
import { ToolOutputStore } from './toolOutputStore'

const tempDirs: string[] = []

afterEach(() => {
  credentialRedactor.setSecrets([])
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sidekick-redaction-'))
  tempDirs.push(dir)
  return dir
}

/** Runs a Node script directly, so a test controls exactly which bytes arrive and when. */
function nodeProcess(script: string): { file: string; args: string[] } {
  return { file: process.execPath, args: ['-e', script] }
}

// Under `npm test` the runner is Electron; this makes it behave as Node for the child.
const NODE_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }

function storedValue(): { value: string; redactor: CredentialRedactor } {
  const value = `sk${randomBytes(18).toString('hex')}`
  const redactor = new CredentialRedactor()
  redactor.setSecrets([{ alias: 'api-key', value }])
  return { value, redactor }
}

describe('credential redaction points', () => {
  it('redacts command output before the log file, the capture and the stream see it', async () => {
    const { value, redactor } = storedValue()
    const dir = tempDir()
    const outputPath = join(dir, 'output.log')
    const chunks: string[] = []
    const command =
      process.platform === 'win32'
        ? `[Console]::Out.WriteLine('key=${value}'); [Console]::Error.WriteLine('err ${value}')`
        : `printf 'key=${value}\\n'; printf 'err ${value}\\n' >&2`
    const result = await new CommandRunner(redactor).run({
      id: 'redacted',
      command,
      cwd: dir,
      timeoutMs: 15_000,
      outputPath,
      onOutput: ({ chunk }) => chunks.push(chunk)
    })
    expect(result.success).toBe(true)
    expect(result.stdout).toContain('key=[secret: api-key]')
    expect(`${result.stdout}${result.stderr}`).not.toContain(value)
    expect(chunks.join('')).not.toContain(value)
    expect(chunks.join('')).toContain('[secret: api-key]')
    expect(readFileSync(outputPath, 'utf8')).not.toContain(value)
  })

  it('redacts command output in a terminal too', async () => {
    const { value, redactor } = storedValue()
    const dir = tempDir()
    const outputPath = join(dir, 'terminal.log')
    const chunks: string[] = []
    const command =
      process.platform === 'win32'
        ? `Write-Output 'token ${value} end'`
        : `printf 'token ${value} end\\n'`
    const result = await new CommandRunner(redactor).run({
      id: 'terminal-redacted',
      command,
      cwd: dir,
      timeoutMs: 15_000,
      outputPath,
      terminal: true,
      onOutput: ({ chunk }) => chunks.push(chunk)
    })
    expect(result.stdout).not.toContain(value)
    expect(chunks.join('')).not.toContain(value)
    expect(existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '').not.toContain(value)
  })

  it('redacts a value printed in pieces between terminal escapes, wherever output goes', async () => {
    const { value, redactor } = storedValue()
    const dir = tempDir()
    const outputPath = join(dir, 'ansi.log')
    const chunks: string[] = []
    const printed = `key=${value.slice(0, 11)}\x1b[31m${value.slice(11, 20)}\x1b[0m${value.slice(20)}\n`
    const result = await new CommandRunner(redactor).run({
      id: 'ansi',
      command: 'print',
      process: nodeProcess(`process.stdout.write(${JSON.stringify(printed)})`),
      env: NODE_ENV,
      cwd: dir,
      timeoutMs: 15_000,
      outputPath,
      onOutput: ({ chunk }) => chunks.push(chunk)
    })
    // eslint-disable-next-line no-control-regex
    const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')
    for (const text of [result.stdout, chunks.join(''), readFileSync(outputPath, 'utf8')]) {
      expect(plain(text)).not.toContain(value.slice(11))
      expect(plain(text)).toContain('key=[secret: api-key]')
    }
  })

  it('redacts a value whose character is split between two pipe chunks', async () => {
    const value = `pé${randomBytes(12).toString('hex')}ü`
    const redactor = new CredentialRedactor()
    redactor.setSecrets([{ alias: 'api-key', value }])
    const dir = tempDir()
    const bytes = Buffer.from(`key=${value}\n`, 'utf8')
    // Cut inside the two bytes of "é", with a pause so the halves arrive as separate chunks.
    const cut = Buffer.from('key=p', 'utf8').length + 1
    const script = `const b = Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64');
      process.stdout.write(b.subarray(0, ${cut}));
      setTimeout(() => process.stdout.write(b.subarray(${cut})), 150)`
    const chunks: string[] = []
    const result = await new CommandRunner(redactor).run({
      id: 'utf8',
      command: 'print',
      process: nodeProcess(script),
      env: NODE_ENV,
      cwd: dir,
      timeoutMs: 15_000,
      outputPath: join(dir, 'utf8.log'),
      onOutput: ({ chunk }) => chunks.push(chunk)
    })
    expect(result.stdout).toBe('key=[secret: api-key]\n')
    expect(chunks.join('')).not.toContain('�')
  })

  it('releases a held tail after a quiet moment, so a prompt still shows', async () => {
    const { value, redactor } = storedValue()
    const dir = tempDir()
    const chunks: string[] = []
    // The prompt ends in what could be the start of the value, then the program waits.
    const script = `process.stdout.write(${JSON.stringify(`Password: ${value.slice(0, 6)}`)});
      setTimeout(() => process.stdout.write(' done\\n'), 1500)`
    await new CommandRunner(redactor).run({
      id: 'quiet',
      command: 'prompt',
      process: nodeProcess(script),
      env: NODE_ENV,
      cwd: dir,
      timeoutMs: 15_000,
      outputPath: join(dir, 'quiet.log'),
      onOutput: ({ chunk }) => chunks.push(chunk)
    })
    // Without the quiet release the held characters would come out only with " done".
    const held = chunks.findIndex((chunk) => chunk.includes(value.slice(0, 6)))
    expect(held).toBeGreaterThanOrEqual(0)
    expect(chunks[held]).not.toContain('done')
    expect(chunks.join('')).toBe(`Password: ${value.slice(0, 6)} done\n`)
  })

  it('redacts a window of retained output that cuts a value at either edge', async () => {
    const { value, redactor } = storedValue()
    const root = tempDir()
    // Kept before the value was stored, so the file still holds it.
    const before = new ToolOutputStore(root, Date.now, new CredentialRedactor())
    const handle = await before.save(`${'a'.repeat(3_000)}${value}${'b'.repeat(3_000)}`)
    const outputs = new ToolOutputStore(root, Date.now, redactor)
    const starting = await outputs.read(handle, 3_000 + 10, 1_024)
    expect(starting.content.startsWith('[secret: api-key]bbb')).toBe(true)
    expect(starting.content).not.toContain(value.slice(10, 30))
    const ending = await outputs.read(handle, 3_000 + 10 - 1_024, 1_024)
    expect(ending.content.endsWith('[secret: api-key]')).toBe(true)
    expect(ending.content).not.toContain(value.slice(0, 10))
  })

  it('redacts retained output before measuring and writing it', async () => {
    const { value, redactor } = storedValue()
    const root = tempDir()
    const outputs = new ToolOutputStore(root, Date.now, redactor)
    const long = Array.from({ length: 4_000 }, (_, line) => `line ${line} ${value}`).join('\n')
    const bounded = await outputs.apply(long, { maxLines: 20 })
    expect(bounded.content).not.toContain(value)
    expect(bounded.output.fullOutputHandle).toBeTruthy()
    const stored = readdirSync(root).map((file) => readFileSync(join(root, file), 'utf8'))
    expect(stored.join('')).not.toContain(value)
    expect(stored.join('')).toContain('[secret: api-key]')
    // Offsets the store reports still point into what it kept.
    const offset = Number(bounded.output.continuation?.offset)
    const read = await outputs.read(bounded.output.fullOutputHandle!, offset, 1_024)
    expect(read.content.startsWith('line ')).toBe(true)

    const sectioned = await outputs.applySections('header', [{ name: 'stdout', text: long }], {
      policy: { maxLines: 20 },
      describeCut: () => 'cut'
    })
    expect(sectioned.content).not.toContain(value)
  })

  it('redacts a value in output kept before it was stored, as it is read back', async () => {
    const { value } = storedValue()
    const root = tempDir()
    const before = new ToolOutputStore(root, Date.now, new CredentialRedactor())
    const handle = await before.save(`old output ${value}`)
    const redactor = new CredentialRedactor()
    redactor.setSecrets([{ alias: 'api-key', value }])
    const after = new ToolOutputStore(root, Date.now, redactor)
    expect((await after.read(handle)).content).toBe('old output [secret: api-key]')
  })

  it('redacts every tool result, failures included', async () => {
    const { value, redactor } = storedValue()
    const registry = new AgentToolRegistry(redactor)
    const call = (executor: () => Promise<unknown>) =>
      registry.execute(
        {
          catalog: { surface: 'conversation', webSearchEnabled: true },
          call: { id: 'call-1', name: 'wait', arguments: { seconds: 1 } },
          title: 'Wait',
          context: { runId: 'run-1', signal: new AbortController().signal }
        },
        vi.fn(executor)
      )
    const success = await call(async () => ({
      status: 'success',
      title: `Found ${value}`,
      modelContent: `the key is ${value}`,
      data: { nested: { value } },
      timing: { startedAt: 1, completedAt: 2, durationMs: 1 }
    }))
    expect(JSON.stringify(success)).not.toContain(value)
    expect(success.modelContent).toBe('the key is [secret: api-key]')
    const failure = await call(async () => {
      throw new Error(`request failed with Authorization: Bearer ${value}`)
    })
    expect(failure.status).toBe('error')
    expect(JSON.stringify(failure)).not.toContain(value)
  })

  it('redacts every outgoing model request, including what the user typed', async () => {
    const { value } = storedValue()
    credentialRedactor.setSecrets([{ alias: 'api-key', value }])
    const request = {
      target: { providerKind: 'litellm' as const, model: 'model' },
      purpose: 'conversation' as const,
      messages: [
        { role: 'system', content: 'You are SideKick.' },
        { role: 'user', content: `here is my key ${value}` },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 't', function: { name: 'shell', arguments: { command: value } } }]
        },
        // A worker's report, and an attachment's name and description.
        { role: 'user', content: `Worker report: deployed with ${value}` },
        {
          role: 'tool',
          tool_call_id: 't',
          content: 'ok',
          media: [
            {
              type: 'image' as const,
              mimeType: 'image/png' as const,
              source: {
                type: 'data_url' as const,
                dataUrl:
                  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
              },
              name: `screenshot-${value}.png`,
              description: `The page showed ${value}`
            }
          ]
        }
      ]
    }
    const prepared = await materializeProviderRequestMedia(request)
    expect(JSON.stringify(prepared)).not.toContain(value)
    expect(prepared.messages[4].media?.[0]).toMatchObject({
      name: 'screenshot-[secret: api-key].png',
      description: 'The page showed [secret: api-key]'
    })
    expect(prepared.messages[1].content).toBe('here is my key [secret: api-key]')
    expect(prepared.messages[0]).toBe(request.messages[0])
    expect(request.messages[1].content).toContain(value)
  })
})
