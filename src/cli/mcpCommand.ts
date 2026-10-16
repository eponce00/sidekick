import {
  ControlError,
  type ControlMcpAddParams,
  type ControlMcpServer
} from '../shared/controlProtocol'

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export const MCP_HELP = `Usage: sidekick mcp <list|add|remove> [options]

  mcp list [--json]
      Every connector, what it runs or contacts, whether you approved that exact content, and
      its connection state. Environment values are never shown.

  mcp add <id> --command CMD [--arg ARG]... [--cwd DIR] [--env NAME]... [options] [-- ARG...]
  mcp add <id> --url URL [--oauth] [options]
      Add a local or remote connector. SideKick shows everything it will run or contact and
      waits for you to allow it. Any later change to the command, arguments, folder,
      environment, URL, or read auto-approval needs approval again.

      --name NAME     Display name (defaults to the id)
      --env NAME      Give the connector environment variable NAME, copied from this command's
                      own environment. Values are encrypted by SideKick and never printed.
                      NAME=VALUE is refused so values stay out of shell history.
      --reads-auto    Let tools the server marks read-only run without asking
      --disabled      Add it switched off
      --replace       Replace an existing connector with the same id

  mcp remove <id> [--json]
      Remove a connector, its stored environment values, and its approval.

Example:
  GITHUB_TOKEN=... sidekick mcp add github --command npx --env GITHUB_TOKEN -- -y @modelcontextprotocol/server-github`

class UsageError extends ControlError {
  constructor(message: string) {
    super('usage', message)
  }
}

const GLOBAL_FLAGS = new Set(['--json', '--dev', '-h', '--help'])

/**
 * Parses the arguments after `mcp add`. Messages never repeat an argument that could be a
 * secret; environment values come only from `env`.
 */
export function parseMcpAdd(rest: string[], env: NodeJS.ProcessEnv): ControlMcpAddParams {
  const params: ControlMcpAddParams = { id: '' }
  const args: string[] = []
  const environment: Record<string, string> = {}
  const value = (index: number, option: string): string => {
    const next = rest[index]
    if (next === undefined || next.startsWith('--'))
      throw new UsageError(`${option} needs a value.`)
    return next
  }
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]
    if (GLOBAL_FLAGS.has(arg)) continue
    switch (arg) {
      case '--user-data-dir':
        index++
        break
      case '--name':
        params.name = value(++index, arg)
        break
      case '--command':
        params.command = value(++index, arg)
        break
      case '--arg':
        args.push(value(++index, arg))
        break
      case '--cwd':
        params.cwd = value(++index, arg)
        break
      case '--url':
        params.url = value(++index, arg)
        break
      case '--oauth':
        params.authentication = 'oauth'
        break
      case '--reads-auto':
        params.approvalMode = 'reads-auto'
        break
      case '--disabled':
        params.enabled = false
        break
      case '--replace':
        params.replace = true
        break
      case '--env': {
        const name = rest[++index] ?? ''
        if (name.includes('=')) {
          throw new UsageError(
            "Pass only the variable's name to --env. SideKick copies its value from this command's environment, so the value never lands in shell history."
          )
        }
        if (!ENV_NAME.test(name)) {
          throw new UsageError('--env needs an environment variable name.')
        }
        const found = env[name]
        if (!found) throw new UsageError(`Environment variable ${name} is not set or is empty.`)
        environment[name] = found
        break
      }
      case '--':
        args.push(...rest.slice(index + 1))
        index = rest.length
        break
      default:
        if (arg.startsWith('-')) {
          throw new UsageError('Unknown option for mcp add. See `sidekick mcp --help`.')
        }
        if (params.id) throw new UsageError('mcp add takes one id. Put server arguments after --.')
        params.id = arg
    }
  }
  if (!params.id) throw new UsageError('Name the connector: sidekick mcp add <id> ...')
  if ((params.command === undefined) === (params.url === undefined)) {
    throw new UsageError('Give either --command for a local connector or --url for a remote one.')
  }
  if (params.url !== undefined && (args.length || params.cwd || Object.keys(environment).length)) {
    throw new UsageError('--arg, --cwd, and --env apply only to local connectors.')
  }
  if (params.command !== undefined) params.args = args
  if (Object.keys(environment).length) params.env = environment
  return params
}

function target(server: ControlMcpServer): string {
  if (server.transport === 'streamable-http') {
    return `${server.url}${server.authentication === 'oauth' ? ' (OAuth)' : ''}`
  }
  return [server.command, ...(server.args ?? [])].join(' ')
}

export function renderMcpServer(server: ControlMcpServer): string {
  const state = [
    server.enabled ? 'enabled' : 'disabled',
    server.approved ? 'approved' : 'NEEDS APPROVAL',
    server.status + (server.toolCount ? `, ${server.toolCount} tools` : '')
  ].join(', ')
  const lines = [
    `${server.id}  ${server.name} (${server.transport})  ${state}`,
    `  ${target(server)}`
  ]
  if (server.cwd) lines.push(`  folder: ${server.cwd}`)
  if (server.envKeys?.length) lines.push(`  env: ${server.envKeys.join(', ')} (values hidden)`)
  if (server.approvalMode === 'reads-auto') lines.push('  read-only tools run without asking')
  if (server.error) lines.push(`  ${server.error}`)
  return lines.join('\n')
}

export function renderMcpList(servers: ControlMcpServer[]): string {
  return servers.length
    ? servers.map(renderMcpServer).join('\n\n')
    : 'No MCP connectors configured.'
}
