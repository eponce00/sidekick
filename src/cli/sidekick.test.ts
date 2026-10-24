import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_PROTOCOL_VERSION, ControlError } from '../shared/controlProtocol'
import { EDITABLE_SETTINGS } from '../shared/settingsSchema'
import {
  createControlToken,
  createEndpointName,
  endpointFilePath,
  ensureControlDirectory,
  writeEndpointFile
} from '../main/control/controlEndpoint'
import { ControlServer, type ControlHandlers } from '../main/control/controlServer'
import { runCli, type CliIo } from './sidekick'

const SECRET = 'sk-or-v1-0123456789abcdefSECRET'

let userData: string
let token: string
let endpoint: string
let server: ControlServer | null
let handlers: { [K in keyof ControlHandlers]: ReturnType<typeof vi.fn> }

async function startApp(): Promise<void> {
  server = new ControlServer({
    endpoint,
    token,
    appVersion: '1.2.3',
    handlers: handlers as unknown as ControlHandlers
  })
  await server.start()
  writeEndpointFile(userData, {
    protocol: CONTROL_PROTOCOL_VERSION,
    endpoint,
    token,
    pid: process.pid,
    appVersion: '1.2.3'
  })
}

interface Run {
  code: number
  stdout: string
  stderr: string
  stdin: ReturnType<typeof vi.fn>
}

async function run(
  argv: string[],
  options: { stdin?: string; tty?: boolean; env?: NodeJS.ProcessEnv } = {}
): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const stdin = vi.fn(async () => options.stdin ?? '')
  const io: CliIo = {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    readStdin: stdin,
    stdinIsTTY: options.tty ?? false,
    env: { SIDEKICK_USER_DATA_DIR: userData, ...options.env }
  }
  const code = await runCli(argv, io)
  return { code, stdout, stderr, stdin }
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'sidekick-cli-'))
  token = createControlToken()
  endpoint = createEndpointName(ensureControlDirectory(userData))
  server = null
  handlers = {
    'config.list': vi.fn(async () => ({
      settings: [
        { key: 'webSearchEnabled', value: true, isDefault: true, descriptor: EDITABLE_SETTINGS[0] }
      ]
    })),
    'config.get': vi.fn(async ({ key }: { key: string }) => {
      if (key !== 'textScale') throw new ControlError('not-found', 'Unknown setting.')
      return { key, value: 110, isDefault: false, descriptor: EDITABLE_SETTINGS[0] }
    }),
    'config.set': vi.fn(async ({ key, value }: { key: string; value: unknown }) => ({
      key,
      previous: 100,
      value: Number(value),
      changed: true
    })),
    'config.unset': vi.fn(),
    'config.reference': vi.fn(),
    'auth.set': vi.fn(async ({ providerInstanceId }: { providerInstanceId: string }) => ({
      providerInstanceId,
      apiKeyConfigured: true
    })),
    'mcp.list': vi.fn(),
    'mcp.add': vi.fn(),
    'mcp.remove': vi.fn(),
    'provider.list': vi.fn(),
    'provider.add': vi.fn(),
    'provider.set': vi.fn(),
    'provider.remove': vi.fn(),
    doctor: vi.fn(async () => ({
      appVersion: '1.2.3',
      protocol: 1,
      platform: 'test',
      settingsFile: 'config.json',
      unknownKeys: [],
      invalidSettings: [],
      credentialStorage: { secure: true, backend: 'dpapi' },
      providers: [
        {
          id: 'openrouter',
          name: 'OpenRouter',
          type: 'openrouter',
          enabled: true,
          apiKeyConfigured: true
        }
      ],
      mcpServers: []
    }))
  }
})

afterEach(async () => {
  await server?.close()
  rmSync(userData, { recursive: true, force: true })
})

function expectSecretAbsent(result: Run): void {
  expect(result.stdout).not.toContain(SECRET)
  expect(result.stderr).not.toContain(SECRET)
  expect(result.stdout + result.stderr).not.toContain('SECRET')
}

describe('auth set never takes a key from arguments', () => {
  beforeEach(startApp)

  it.each([
    [['auth', 'set', 'openrouter', SECRET]],
    [['auth', 'set', 'openrouter', SECRET, '--stdin']],
    [['auth', 'set', 'openrouter', '--stdin', SECRET]],
    [['auth', 'set', 'openrouter', `--key=${SECRET}`]],
    [['auth', 'set', 'openrouter', '--api-key', SECRET]],
    [['auth', 'set', 'openrouter', `--${SECRET}`]],
    [['auth', 'set', 'openrouter', '--from-env', SECRET]],
    [['auth', 'set', SECRET]],
    [['auth', 'set', 'openrouter', '--stdin', '--from-env', 'KEY']],
    [['--json', 'auth', 'set', 'openrouter', SECRET]]
  ])('refuses %j without echoing it or contacting SideKick', async (argv) => {
    const result = await run(argv, { stdin: SECRET })
    expect(result.code).toBe(2)
    expectSecretAbsent(result)
    expect(result.stdin).not.toHaveBeenCalled()
    expect(handlers['auth.set']).not.toHaveBeenCalled()
  })

  it('refuses to read a key from an interactive terminal', async () => {
    const result = await run(['auth', 'set', 'openrouter', '--stdin'], { tty: true })
    expect(result.code).toBe(2)
    expect(result.stdin).not.toHaveBeenCalled()
  })

  it('reads a piped key, trims the newline, and never prints it', async () => {
    const result = await run(['auth', 'set', 'openrouter', '--stdin', '--json'], {
      stdin: `${SECRET}\n`
    })
    expect(result.code).toBe(0)
    expect(handlers['auth.set']).toHaveBeenCalledWith({
      providerInstanceId: 'openrouter',
      secret: SECRET
    })
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      result: { providerInstanceId: 'openrouter', apiKeyConfigured: true }
    })
    expectSecretAbsent(result)
  })

  it('reads a key from a named environment variable', async () => {
    const result = await run(['auth', 'set', 'openrouter', '--from-env', 'OPENROUTER_KEY'], {
      env: { OPENROUTER_KEY: SECRET }
    })
    expect(result.code).toBe(0)
    expect(handlers['auth.set']).toHaveBeenCalledWith({
      providerInstanceId: 'openrouter',
      secret: SECRET
    })
    expectSecretAbsent(result)
  })

  it('reports a missing environment variable without naming its value', async () => {
    const result = await run(['auth', 'set', 'openrouter', '--from-env', 'NOT_SET_ANYWHERE'])
    expect(result.code).toBe(2)
    expect(handlers['auth.set']).not.toHaveBeenCalled()
  })

  it('refuses an empty key', async () => {
    const result = await run(['auth', 'set', 'openrouter', '--stdin'], { stdin: '\n' })
    expect(result.code).toBe(6)
    expect(handlers['auth.set']).not.toHaveBeenCalled()
  })

  it('passes server refusals through without the key', async () => {
    handlers['auth.set'].mockRejectedValue(
      new ControlError('storage-locked', 'Secure credential storage is unavailable.')
    )
    const result = await run(['auth', 'set', 'openrouter', '--stdin', '--json'], { stdin: SECRET })
    expect(result.code).toBe(8)
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: { code: 'storage-locked', message: 'Secure credential storage is unavailable.' }
    })
    expectSecretAbsent(result)
  })
})

describe('config and doctor', () => {
  beforeEach(startApp)

  it('prints a bare value for config get', async () => {
    const result = await run(['config', 'get', 'textScale'])
    expect(result).toMatchObject({ code: 0, stdout: '110\n' })
  })

  it('maps server error codes to exit codes', async () => {
    const result = await run(['config', 'get', 'nope', '--json'])
    expect(result.code).toBe(5)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })

  it('sends config set values as typed by the user', async () => {
    const result = await run(['config', 'set', 'textScale', '110'])
    expect(result.code).toBe(0)
    expect(handlers['config.set']).toHaveBeenCalledWith({ key: 'textScale', value: '110' })
    expect(result.stdout).toBe('textScale: 100 -> 110\n')
  })

  it('refuses to send a key-like setting to SideKick at all', async () => {
    const result = await run(['config', 'set', 'openRouterApiKey', SECRET])
    expect(result.code).toBe(5)
    expect(handlers['config.set']).not.toHaveBeenCalled()
    expectSecretAbsent(result)
    expect(result.stderr).toContain('sidekick auth set')
  })

  it('reports key presence as yes or no in doctor', async () => {
    const result = await run(['doctor'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('openrouter  OpenRouter (openrouter)  key stored')
  })

  it('rejects unknown options and extra arguments', async () => {
    expect((await run(['config', 'list', '--force'])).code).toBe(2)
    expect((await run(['config', 'set', 'a', 'b', 'c'])).code).toBe(2)
    expect((await run(['nonsense'])).code).toBe(2)
  })
})

describe('connection failures', () => {
  it('exits 3 when SideKick is not running', async () => {
    const result = await run(['config', 'list', '--json'])
    expect(result.code).toBe(3)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'not-running' } })
  })

  it('exits 3 when the endpoint file is left from a crashed launch', async () => {
    writeEndpointFile(userData, {
      protocol: CONTROL_PROTOCOL_VERSION,
      endpoint,
      token,
      pid: 1,
      appVersion: '1.2.3'
    })
    expect((await run(['doctor'])).code).toBe(3)
  })

  it('exits 4 when the token is rejected', async () => {
    await startApp()
    writeEndpointFile(userData, {
      protocol: CONTROL_PROTOCOL_VERSION,
      endpoint,
      token: createControlToken(),
      pid: process.pid,
      appVersion: '1.2.3'
    })
    const result = await run(['config', 'list'])
    expect(result.code).toBe(4)
    expect(handlers['config.list']).not.toHaveBeenCalled()
  })

  it('exits 9 for an app speaking another protocol', async () => {
    writeEndpointFile(userData, {
      protocol: CONTROL_PROTOCOL_VERSION + 1,
      endpoint,
      token,
      pid: process.pid,
      appVersion: '9.0.0'
    })
    expect((await run(['doctor'])).code).toBe(9)
  })

  it.skipIf(process.platform === 'win32')(
    'refuses an endpoint file other accounts can read',
    async () => {
      await startApp()
      chmodSync(endpointFilePath(userData), 0o644)
      const result = await run(['config', 'list'])
      expect(result.code).toBe(4)
      expect(handlers['config.list']).not.toHaveBeenCalled()
    }
  )

  it('treats a corrupt endpoint file as not running', async () => {
    writeFileSync(endpointFilePath(userData), '{not json', { mode: 0o600 })
    expect((await run(['doctor'])).code).toBe(3)
  })
})

describe('help and offline commands', () => {
  it('documents every command, option, and exit code', async () => {
    const result = await run(['--help'])
    expect(result.code).toBe(0)
    for (const text of [
      'config list',
      'config get',
      'config set',
      'config unset',
      'config reference',
      'auth set',
      'doctor',
      '--json',
      '--dev',
      '--user-data-dir',
      '9 protocol mismatch'
    ]) {
      expect(result.stdout).toContain(text)
    }
  })

  it('prints usage and exits 2 with no command', async () => {
    const result = await run([])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Usage: sidekick')
  })

  it('prints the settings reference without the app', async () => {
    const result = await run(['config', 'reference'])
    expect(result.code).toBe(0)
    for (const setting of EDITABLE_SETTINGS) expect(result.stdout).toContain(`\`${setting.key}\``)
    expect(result.stdout).toContain('sidekick auth set')
  })
})

describe('mcp commands', () => {
  beforeEach(async () => {
    handlers['mcp.add'].mockImplementation(async (params: { id: string }) => ({
      replaced: false,
      server: {
        id: params.id,
        name: params.id,
        transport: 'stdio',
        enabled: true,
        approvalMode: 'prompt',
        command: 'npx',
        args: [],
        envKeys: ['TOKEN'],
        approved: true,
        status: 'unknown',
        toolCount: 0
      }
    }))
    await startApp()
  })

  it('copies --env values from its own environment and never prints them', async () => {
    const result = await run(
      ['mcp', 'add', 'github', '--command', 'npx', '--env', 'TOKEN', '--', '-y', 'server-github'],
      { env: { TOKEN: SECRET } }
    )
    expect(result.code).toBe(0)
    expect(handlers['mcp.add']).toHaveBeenCalledWith({
      id: 'github',
      command: 'npx',
      args: ['-y', 'server-github'],
      env: { TOKEN: SECRET }
    })
    expectSecretAbsent(result)
    expect(result.stdout).toContain('env: TOKEN (values hidden)')
  })

  it.each([
    [['mcp', 'add', 'github', '--command', 'npx', '--env', `TOKEN=${SECRET}`]],
    [['mcp', 'add', 'github', '--command', 'npx', `--token=${SECRET}`]],
    [['mcp', 'add', 'github', '--command', 'npx', '--env', SECRET]],
    [['mcp', 'add', 'github', '--url', 'https://x.example/mcp', '--env', 'TOKEN']]
  ])('refuses %j without echoing or contacting SideKick', async (argv) => {
    const result = await run(argv, { env: { TOKEN: SECRET } })
    expect(result.code).toBe(2)
    expectSecretAbsent(result)
    expect(handlers['mcp.add']).not.toHaveBeenCalled()
  })

  it('requires an environment variable that is set', async () => {
    const result = await run(['mcp', 'add', 'x', '--command', 'npx', '--env', 'UNSET_HERE'])
    expect(result.code).toBe(2)
  })

  it('removes and lists through the app', async () => {
    handlers['mcp.remove'].mockResolvedValue({ id: 'files', removed: true })
    handlers['mcp.list'].mockResolvedValue({ servers: [] })
    expect((await run(['mcp', 'remove', 'files'])).stdout).toBe('Removed files.\n')
    expect((await run(['mcp', 'list'])).stdout).toBe('No MCP connectors configured.\n')
  })
})

describe('provider commands', () => {
  beforeEach(startApp)

  it('sends base URL changes and never treats extra input as a key', async () => {
    handlers['provider.set'].mockResolvedValue({
      changed: ['baseUrl'],
      provider: {
        id: 'openrouter',
        name: 'OpenRouter',
        kind: 'openrouter',
        enabled: true,
        baseUrl: 'https://proxy.example.com/v1',
        modelSource: 'discover',
        enabledModels: [],
        apiKeyConfigured: true
      }
    })
    const result = await run([
      'provider',
      'set',
      'openrouter',
      '--base-url',
      'https://proxy.example.com/v1'
    ])
    expect(result.code).toBe(0)
    expect(handlers['provider.set']).toHaveBeenCalledWith({
      id: 'openrouter',
      baseUrl: 'https://proxy.example.com/v1'
    })
    expect(result.stdout).toContain('key stored')
  })

  it.each([
    [['provider', 'set', 'openrouter', `--api-key=${SECRET}`]],
    [['provider', 'set', 'openrouter', SECRET]],
    [['provider', 'add', 'x', '--kind', 'openrouter', '--key', SECRET]]
  ])('refuses %j without echoing it', async (argv) => {
    const result = await run(argv)
    expect(result.code).toBe(2)
    expectSecretAbsent(result)
    expect(handlers['provider.set']).not.toHaveBeenCalled()
    expect(handlers['provider.add']).not.toHaveBeenCalled()
  })
})
