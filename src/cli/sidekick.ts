/**
 * The `sidekick` command line. It never touches SideKick's files: every command is a request to
 * the running app, which validates it, asks the user when a change weakens security, and keeps
 * provider keys encrypted.
 */
import { version as cliVersion } from '../../package.json'
import {
  CONTROL_EXIT_CODES,
  CONTROL_MAX_SECRET_LENGTH,
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  type ControlDoctorReport,
  type ControlEndpointFile,
  type ControlSettingChange,
  type ControlSettingEntry
} from '../shared/controlProtocol'
import { defaultUserDataDirectory, readEndpointFile } from '../main/control/controlEndpoint'
import { renderSettingsReference } from '../shared/settingsSchema'
import { ControlClient } from './controlClient'
import { MCP_HELP, parseMcpAdd, renderMcpList, renderMcpServer } from './mcpCommand'
import {
  parseProviderChange,
  PROVIDER_HELP,
  renderProvider,
  renderProviderList
} from './providerCommand'

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Reads standard input to its end, giving up past `limit` bytes. */
  readStdin: (limit: number) => Promise<string>
  stdinIsTTY: boolean
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

const APPROVAL_TIMEOUT_MS = 10 * 60_000
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const SECRET_LIKE_KEY = /api.?key|secret|token|password|credential/i

const HELP: Record<string, string> = {
  main: `Usage: sidekick <command> [options]

Inspect and configure the running SideKick app. Commands never print an API key.

Commands:
  config list               List the settings you can change, with their values
  config get <key>          Print one setting
  config set <key> <value>  Change one setting
  config unset <key>        Return one setting to its default
  config reference          Print the settings reference for agents
  auth set <provider-instance> --stdin | --from-env NAME
                            Store a provider API key, encrypted by SideKick
  provider list             List provider instances and whether each has a key
  provider add <id> ...     Add a provider instance
  provider set <id> ...     Rename, enable, or move a provider; a new address needs approval
  provider remove <id>      Remove a provider instance and its key
  mcp list                  List MCP connectors and whether each is approved
  mcp add <id> ...          Add a connector; SideKick asks you to allow it
  mcp remove <id>           Remove a connector
  doctor                    Report version, settings problems, key storage, and connectors

Options:
  --json                Print one JSON document: {"ok":true,"result":...} or
                        {"ok":false,"error":{"code":...,"message":...}}
  --dev                 Talk to a development build (the sidekick-dev profile)
  --user-data-dir PATH  Talk to the app using this profile directory
                        (also SIDEKICK_USER_DATA_DIR)
  -h, --help            Show help for a command
  -V, --version         Print the CLI version

Exit codes:
  0 success            5 unknown setting, provider instance, or connector
  1 internal error     6 invalid value
  2 usage error        7 declined in SideKick
  3 not running        8 secure credential storage unavailable
  4 unauthorized       9 protocol mismatch

SideKick must be running. The CLI never edits SideKick's files directly.`,
  config: `Usage: sidekick config <list|get|set|unset|reference> [options]

  config list [--json]              Every changeable setting, its value, and whether it is the default
  config get <key> [--json]         One setting; prints just the value without --json
  config set <key> <value> [--json] Validate and apply a value. Sensitive changes, such as granting
                                    full access, wait for approval in SideKick.
  config unset <key> [--json]       Return a setting to its default
  config reference                  Every setting with its type, bounds, and default (Markdown)

API keys are not settings; use \`sidekick auth set\`.`,
  auth: `Usage: sidekick auth set <provider-instance> (--stdin | --from-env NAME) [--json]

Stores an API key for a configured provider instance. SideKick encrypts it with the operating
system's credential storage. The key is never accepted as an argument, never printed, and never
returned by any command.

  --stdin          Read the key from standard input (pipe it; a terminal is refused)
  --from-env NAME  Read the key from environment variable NAME

Run \`sidekick doctor\` to list provider instance ids.

Examples:
  printenv OPENROUTER_API_KEY | sidekick auth set openrouter --stdin
  sidekick auth set openrouter --from-env OPENROUTER_API_KEY`,
  mcp: MCP_HELP,
  provider: PROVIDER_HELP,
  doctor: `Usage: sidekick doctor [--json]

Reports the app version, the settings file, stored keys SideKick does not recognize, settings
whose stored value is invalid, the credential storage backend, which providers have a key
(yes or no only), and connector health. Exits 0 whenever SideKick could be asked.`
}

interface ParsedArgs {
  json: boolean
  help: boolean
  version: boolean
  development: boolean
  userDataDir?: string
  positionals: string[]
  options: string[]
}

class UsageError extends ControlError {
  constructor(message: string) {
    super('usage', message)
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    json: false,
    help: false,
    version: false,
    development: false,
    positionals: [],
    options: []
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--json') parsed.json = true
    else if (arg === '-h' || arg === '--help') parsed.help = true
    else if (arg === '-V' || arg === '--version') parsed.version = true
    else if (arg === '--dev') parsed.development = true
    else if (arg === '--user-data-dir') {
      const value = argv[++index]
      if (!value) throw new UsageError('--user-data-dir needs a path.')
      parsed.userDataDir = value
    } else if (arg === '--') {
      parsed.positionals.push(...argv.slice(index + 1))
      break
    } else if (arg.startsWith('-') && arg !== '-') parsed.options.push(arg)
    else parsed.positionals.push(arg)
  }
  return parsed
}

/** Indexes of arguments that are not options or option values. */
function positionalIndexes(argv: string[]): number[] {
  const indexes: number[] = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--user-data-dir' || argv[index] === '--from-env') index++
    else if (!argv[index].startsWith('-')) indexes.push(index)
  }
  return indexes
}

type AuthSetArgs =
  | { providerInstanceId: string; source: 'stdin' }
  | { providerInstanceId: string; source: 'env'; name: string }

/**
 * Parses the arguments after `auth set` strictly. Messages never repeat an argument, which may
 * be a pasted key.
 */
function parseAuthSet(rest: string[]): AuthSetArgs {
  let providerInstanceId: string | undefined
  let source: 'stdin' | 'env' | undefined
  let name: string | undefined
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]
    if (arg === '--json' || arg === '--dev' || arg === '-h' || arg === '--help') continue
    if (arg === '--user-data-dir') {
      index++
      continue
    }
    if (arg === '--stdin' || arg === '--from-env') {
      if (source) throw new UsageError('Use exactly one of --stdin or --from-env.')
      source = arg === '--stdin' ? 'stdin' : 'env'
      if (source === 'env') {
        name = rest[++index]
        if (!name || !ENV_NAME.test(name)) {
          throw new UsageError('--from-env needs the name of an environment variable, not a key.')
        }
      }
      continue
    }
    if (arg.startsWith('-')) {
      throw new UsageError(
        'auth set accepts only --stdin or --from-env NAME. Keys are never accepted as arguments.'
      )
    }
    if (providerInstanceId !== undefined) {
      throw new UsageError(
        'auth set takes one provider instance and never a key as an argument. Pipe the key with --stdin or name an environment variable with --from-env.'
      )
    }
    providerInstanceId = arg
  }
  if (!providerInstanceId)
    throw new UsageError('Name the provider instance. See `sidekick doctor`.')
  if (!source) {
    throw new UsageError('Pass --stdin or --from-env NAME. Keys are never accepted as arguments.')
  }
  return source === 'env'
    ? { providerInstanceId, source, name: name! }
    : { providerInstanceId, source }
}

async function readSecret(auth: AuthSetArgs, io: CliIo): Promise<string> {
  let secret: string
  if (auth.source === 'env') {
    secret = io.env[auth.name] ?? ''
    if (!secret) throw new UsageError('That environment variable is not set or is empty.')
  } else {
    if (io.stdinIsTTY) {
      throw new UsageError(
        'Refusing to read a key from a terminal, where it would be echoed. Pipe it in, or use --from-env.'
      )
    }
    secret = await io.readStdin(CONTROL_MAX_SECRET_LENGTH + 2)
  }
  // Tools that print a key usually end it with a newline.
  secret = secret.replace(/\r?\n$/, '')
  if (!secret) throw new ControlError('invalid-value', 'The key is empty.')
  return secret
}

function endpointFor(parsed: ParsedArgs, io: CliIo): ControlEndpointFile {
  const userData =
    parsed.userDataDir ??
    defaultUserDataDirectory({
      development: parsed.development,
      env: io.env,
      platform: io.platform
    })
  const lookup = readEndpointFile(userData, io.platform)
  if (lookup.status === 'found') {
    if (lookup.file.protocol !== CONTROL_PROTOCOL_VERSION) {
      throw new ControlError(
        'protocol-mismatch',
        `SideKick ${lookup.file.appVersion} speaks control protocol ${lookup.file.protocol}; this CLI speaks ${CONTROL_PROTOCOL_VERSION}.`
      )
    }
    return lookup.file
  }
  if (lookup.status === 'unsafe') {
    throw new ControlError('unauthorized', `Refusing to connect: ${lookup.reason}.`)
  }
  throw new ControlError(
    'not-running',
    'SideKick is not running. Start SideKick, then run the command again.'
  )
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? (value === '' ? '(empty)' : value) : String(value)
}

function renderList(settings: ControlSettingEntry[]): string {
  const width = Math.max(...settings.map((setting) => setting.key.length))
  return settings
    .map(
      (setting) =>
        `${setting.key.padEnd(width)}  ${formatValue(setting.value)}${setting.isDefault ? '  (default)' : ''}`
    )
    .join('\n')
}

function renderChange(change: ControlSettingChange): string {
  return change.changed
    ? `${change.key}: ${formatValue(change.previous)} -> ${formatValue(change.value)}`
    : `${change.key} is already ${formatValue(change.value)}`
}

function renderDoctor(report: ControlDoctorReport): string {
  const lines = [
    `SideKick ${report.appVersion} (${report.platform}), control protocol ${report.protocol}`,
    `Settings file: ${report.settingsFile}`,
    `Credential storage: ${report.credentialStorage.backend} (${report.credentialStorage.secure ? 'secure' : 'UNAVAILABLE: new keys cannot be stored'})`,
    '',
    'Providers:'
  ]
  if (!report.providers.length) lines.push('  none configured')
  for (const provider of report.providers) {
    lines.push(
      `  ${provider.id}  ${provider.name} (${provider.type})${provider.enabled ? '' : ' [disabled]'}  ${provider.apiKeyConfigured ? 'key stored' : 'no key'}`
    )
  }
  lines.push('', 'MCP servers:')
  if (!report.mcpServers.length) lines.push('  none configured')
  for (const server of report.mcpServers) {
    lines.push(
      `  ${server.id}  ${server.name} (${server.transport})  ${server.approved ? '' : 'NEEDS APPROVAL, '}${server.status}${server.toolCount ? `, ${server.toolCount} tools` : ''}${server.error ? `: ${server.error}` : ''}`
    )
  }
  lines.push(
    '',
    `Unknown stored keys: ${report.unknownKeys.length ? report.unknownKeys.join(', ') : 'none'}`,
    `Invalid settings: ${report.invalidSettings.length ? report.invalidSettings.map((item) => `${item.key} (${item.reason})`).join(', ') : 'none'}`
  )
  return lines.join('\n')
}

async function withClient<T>(
  parsed: ParsedArgs,
  io: CliIo,
  run: (client: ControlClient) => Promise<T>
): Promise<T> {
  const client = await ControlClient.connect(endpointFor(parsed, io), `sidekick-cli/${cliVersion}`)
  try {
    return await run(client)
  } finally {
    client.close()
  }
}

function settingKey(parsed: ParsedArgs, usage: string): string {
  const key = parsed.positionals[2]
  if (!key) throw new UsageError(usage)
  if (SECRET_LIKE_KEY.test(key)) {
    throw new ControlError(
      'not-found',
      'API keys are not settings. Store one with `sidekick auth set <provider-instance> --stdin`.'
    )
  }
  return key
}

/** Only the flags that pick which app to talk to, from an argument list parsed elsewhere. */
function connectionArgs(argv: string[]): ParsedArgs {
  const userDataIndex = argv.indexOf('--user-data-dir')
  return parseArgs([
    ...(argv.includes('--dev') ? ['--dev'] : []),
    ...(userDataIndex === -1 ? [] : ['--user-data-dir', argv[userDataIndex + 1] ?? ''])
  ])
}

function rejectOptions(parsed: ParsedArgs): void {
  if (parsed.options.length) {
    throw new UsageError(`Unknown option ${parsed.options[0].split('=')[0]}. See --help.`)
  }
}

/** Runs one CLI invocation and returns its exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let json = argv.includes('--json')
  const succeed = (result: unknown, text: string): number => {
    if (json) io.stdout(`${JSON.stringify({ ok: true, result }, null, 2)}\n`)
    else if (text) io.stdout(`${text}\n`)
    return 0
  }
  try {
    const positions = positionalIndexes(argv)
    // auth is parsed before anything else so no general path can echo its arguments.
    if (argv[positions[0]] === 'auth') {
      if (argv.includes('-h') || argv.includes('--help')) return succeed(HELP.auth, HELP.auth)
      if (argv[positions[1]] !== 'set') {
        throw new UsageError(
          'Usage: sidekick auth set <provider-instance> --stdin | --from-env NAME'
        )
      }
      const auth = parseAuthSet(argv.slice(positions[1] + 1))
      const secret = await readSecret(auth, io)
      const result = await withClient(connectionArgs(argv), io, (client) =>
        client.call('auth.set', { providerInstanceId: auth.providerInstanceId, secret })
      )
      return succeed(result, `Stored an encrypted key for ${result.providerInstanceId}.`)
    }
    // mcp add takes option values and environment names, so it gets its own strict parser too.
    if (argv[positions[0]] === 'mcp' && argv[positions[1]] === 'add') {
      if (argv.includes('-h') || argv.includes('--help')) return succeed(MCP_HELP, MCP_HELP)
      const params = parseMcpAdd(argv.slice(positions[1] + 1), io.env)
      const result = await withClient(connectionArgs(argv), io, (client) =>
        client.call('mcp.add', params, APPROVAL_TIMEOUT_MS)
      )
      return succeed(
        result,
        `${result.replaced ? 'Replaced' : 'Added'} and approved:\n${renderMcpServer(result.server)}`
      )
    }

    if (
      argv[positions[0]] === 'provider' &&
      (argv[positions[1]] === 'add' || argv[positions[1]] === 'set')
    ) {
      if (argv.includes('-h') || argv.includes('--help'))
        return succeed(PROVIDER_HELP, PROVIDER_HELP)
      const action = argv[positions[1]] as 'add' | 'set'
      const change = parseProviderChange(action, argv.slice(positions[1] + 1))
      if (action === 'add') {
        const { kind, ...rest } = change
        const result = await withClient(connectionArgs(argv), io, (client) =>
          client.call('provider.add', { ...rest, kind: kind ?? '' }, APPROVAL_TIMEOUT_MS)
        )
        return succeed(result, `Added:\n${renderProvider(result.provider)}`)
      }
      const result = await withClient(connectionArgs(argv), io, (client) =>
        client.call('provider.set', change, APPROVAL_TIMEOUT_MS)
      )
      return succeed(
        result,
        result.changed.length
          ? `Changed ${result.changed.join(', ')}:\n${renderProvider(result.provider)}`
          : `Nothing changed:\n${renderProvider(result.provider)}`
      )
    }

    const parsed = parseArgs(argv)
    json = parsed.json
    if (parsed.version) return succeed({ version: cliVersion }, `sidekick ${cliVersion}`)
    const [group, action] = parsed.positionals
    if (!group || (parsed.help && (!HELP[group] || group === 'main'))) {
      if (!group && !parsed.help) {
        io.stderr(`${HELP.main}\n`)
        return CONTROL_EXIT_CODES.usage
      }
      return succeed(HELP.main, HELP.main)
    }
    if (parsed.help) return succeed(HELP[group], HELP[group])
    rejectOptions(parsed)

    if (group === 'doctor') {
      const report = await withClient(parsed, io, (client) => client.call('doctor', {}))
      return succeed(report, renderDoctor(report))
    }
    if (group === 'provider') {
      if (action === 'list') {
        const result = await withClient(parsed, io, (client) => client.call('provider.list', {}))
        return succeed(result, renderProviderList(result.providers))
      }
      if (action === 'remove') {
        const id = parsed.positionals[2]
        if (!id || parsed.positionals.length > 3) {
          throw new UsageError('Usage: sidekick provider remove <id>')
        }
        const result = await withClient(parsed, io, (client) =>
          client.call('provider.remove', { id })
        )
        return succeed(result, `Removed ${result.id} and its stored key.`)
      }
      throw new UsageError(PROVIDER_HELP)
    }
    if (group === 'mcp') {
      if (action === 'list') {
        const result = await withClient(parsed, io, (client) => client.call('mcp.list', {}))
        return succeed(result, renderMcpList(result.servers))
      }
      if (action === 'remove') {
        const id = parsed.positionals[2]
        if (!id || parsed.positionals.length > 3)
          throw new UsageError('Usage: sidekick mcp remove <id>')
        const result = await withClient(parsed, io, (client) => client.call('mcp.remove', { id }))
        return succeed(result, `Removed ${result.id}.`)
      }
      throw new UsageError(MCP_HELP)
    }
    if (group === 'config') {
      switch (action) {
        case 'list': {
          const result = await withClient(parsed, io, (client) => client.call('config.list', {}))
          return succeed(result, renderList(result.settings))
        }
        case 'get': {
          const key = settingKey(parsed, 'Usage: sidekick config get <key>')
          const result = await withClient(parsed, io, (client) =>
            client.call('config.get', { key })
          )
          return succeed(result, String(result.value))
        }
        case 'set': {
          const key = settingKey(parsed, 'Usage: sidekick config set <key> <value>')
          const value = parsed.positionals[3]
          if (value === undefined || parsed.positionals.length > 4) {
            throw new UsageError('Usage: sidekick config set <key> <value>')
          }
          const result = await withClient(parsed, io, (client) =>
            client.call('config.set', { key, value }, APPROVAL_TIMEOUT_MS)
          )
          return succeed(result, renderChange(result))
        }
        case 'unset': {
          const key = settingKey(parsed, 'Usage: sidekick config unset <key>')
          const result = await withClient(parsed, io, (client) =>
            client.call('config.unset', { key }, APPROVAL_TIMEOUT_MS)
          )
          return succeed(result, renderChange(result))
        }
        case 'reference': {
          // Generated from the schema this CLI shipped with, so it works without the app.
          const markdown = renderSettingsReference()
          return succeed({ markdown }, markdown)
        }
        default:
          throw new UsageError(HELP.config)
      }
    }
    throw new UsageError(`Unknown command. Run \`sidekick --help\`.`)
  } catch (error) {
    const failure =
      error instanceof ControlError
        ? error
        : new ControlError('internal', 'The command failed unexpectedly.')
    if (json) {
      io.stdout(
        `${JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } }, null, 2)}\n`
      )
    } else {
      io.stderr(`sidekick: ${failure.message}\n`)
    }
    return CONTROL_EXIT_CODES[failure.code]
  }
}
