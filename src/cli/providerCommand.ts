import {
  ControlError,
  type ControlProvider,
  type ControlProviderChange
} from '../shared/controlProtocol'
import { PROVIDER_REGISTRY } from '../shared/providerRegistry'

export const PROVIDER_HELP = `Usage: sidekick provider <list|add|set|remove> [options]

  provider list [--json]
      Every provider instance: kind, address, enabled models, and whether a key is stored
      (yes or no only).

  provider add <id> --kind KIND [--name NAME] [--base-url URL] [--disabled]
      Add a provider instance. KIND is one of:
      ${PROVIDER_REGISTRY.map((definition) => definition.kind).join(', ')}
      A base URL other than the kind's default waits for approval in SideKick.

  provider set <id> [--name NAME] [--base-url URL] [--enable | --disable]
      Change an instance. Changing the base URL decides where prompts and the stored key
      are sent, so it always waits for approval in SideKick.

  provider remove <id>
      Remove an instance and its stored key.

Store a key with \`sidekick auth set <id> --stdin\`. Models are discovered and chosen in
Settings.`

class UsageError extends ControlError {
  constructor(message: string) {
    super('usage', message)
  }
}

const GLOBAL_FLAGS = new Set(['--json', '--dev', '-h', '--help'])

/** Parses the arguments after `provider add` or `provider set`. */
export function parseProviderChange(
  action: 'add' | 'set',
  rest: string[]
): ControlProviderChange & { id: string; kind?: string } {
  const parsed: ControlProviderChange & { id: string; kind?: string } = { id: '' }
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
      case '--kind':
        if (action !== 'add')
          throw new UsageError('A provider’s kind cannot change; add a new one.')
        parsed.kind = value(++index, arg)
        break
      case '--name':
        parsed.name = value(++index, arg)
        break
      case '--base-url':
        parsed.baseUrl = value(++index, arg)
        break
      case '--enable':
      case '--disable':
        if (parsed.enabled !== undefined) throw new UsageError('Use one of --enable or --disable.')
        parsed.enabled = arg === '--enable'
        break
      case '--disabled':
        if (action !== 'add') throw new UsageError('Use --disable to switch an instance off.')
        parsed.enabled = false
        break
      default:
        // Never repeat an unknown option; it may be a pasted key.
        if (arg.startsWith('-')) {
          throw new UsageError(
            `Unknown option for provider ${action}. Keys are stored with sidekick auth set.`
          )
        }
        if (parsed.id) throw new UsageError(`provider ${action} takes one id.`)
        parsed.id = arg
    }
  }
  if (!parsed.id)
    throw new UsageError(`Name the provider instance: sidekick provider ${action} <id>`)
  if (action === 'add' && !parsed.kind) throw new UsageError('provider add needs --kind.')
  if (action === 'set' && Object.keys(parsed).length === 1) {
    throw new UsageError('Give something to change: --name, --base-url, --enable, or --disable.')
  }
  return parsed
}

export function renderProvider(provider: ControlProvider): string {
  const models = provider.enabledModels.length
    ? `${provider.enabledModels.length} model${provider.enabledModels.length === 1 ? '' : 's'}`
    : 'no models chosen'
  return [
    `${provider.id}  ${provider.name} (${provider.kind})${provider.enabled ? '' : ' [disabled]'}  ${provider.apiKeyConfigured ? 'key stored' : 'no key'}`,
    `  ${provider.baseUrl}  ${models}`
  ].join('\n')
}

export function renderProviderList(providers: ControlProvider[]): string {
  return providers.length
    ? providers.map(renderProvider).join('\n')
    : 'No provider instances configured.'
}
