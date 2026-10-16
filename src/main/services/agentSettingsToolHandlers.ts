import {
  toolExecutionFailed,
  toolExecutionSucceeded,
  type AgentApprovalPreview
} from '../../shared/agentRuntime'
import {
  PROVIDER_REQUEST_KEY_TOOL,
  SETTINGS_PROPOSE_CHANGE_TOOL,
  SETTINGS_READ_TOOL,
  SETTINGS_REFERENCE_TOOL
} from '../../shared/appSettingsTools'
import { ControlError } from '../../shared/controlProtocol'
import { editableSetting, renderSettingsReference } from '../../shared/settingsSchema'
import type { ControlHandlers } from '../control/controlServer'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'

/** What the settings tools may use: secret-free control methods and the key prompt. */
export interface AppSettingsToolAccess {
  control: Pick<
    ControlHandlers,
    'config.list' | 'config.get' | 'config.set' | 'config.unset' | 'provider.list' | 'mcp.list'
  >
  openProviderKeyPrompt: (providerInstanceId: string) => boolean
}

function display(value: unknown): string {
  return value === '' ? '(empty)' : String(value)
}

function failure(title: string, error: unknown): ReturnType<typeof toolExecutionFailed> {
  if (error instanceof ControlError) {
    return toolExecutionFailed({
      title,
      code: error.code === 'denied' ? 'permission_denied' : 'invalid_arguments',
      message: error.message,
      ...(error.code === 'denied' ? { status: 'denied' as const } : {})
    })
  }
  return toolExecutionFailed({
    title,
    code: 'internal',
    message: 'SideKick could not complete the request.'
  })
}

/** Registers the tools that let SideKick's agent inspect and change SideKick. */
export function registerSettingsToolHandlers(
  handlers: AgentToolHandlerRegistry,
  access: AppSettingsToolAccess
): void {
  handlers.register(SETTINGS_READ_TOOL, async ({ title, arguments: args }) => {
    const section = typeof args.section === 'string' ? args.section : 'all'
    try {
      const data: Record<string, unknown> = {}
      if (section === 'all' || section === 'settings') {
        data.settings = (await access.control['config.list']({})).settings.map((entry) => ({
          key: entry.key,
          value: entry.value,
          isDefault: entry.isDefault,
          description: entry.descriptor.description
        }))
      }
      if (section === 'all' || section === 'providers') {
        data.providers = (await access.control['provider.list']({})).providers
      }
      if (section === 'all' || section === 'mcp') {
        data.mcpServers = (await access.control['mcp.list']({})).servers
      }
      return toolExecutionSucceeded({ title, data, modelContent: JSON.stringify(data, null, 2) })
    } catch (error) {
      return failure(title, error)
    }
  })

  handlers.register(SETTINGS_REFERENCE_TOOL, async ({ title }) => {
    const markdown = renderSettingsReference()
    return toolExecutionSucceeded({ title, data: { markdown }, modelContent: markdown })
  })

  handlers.register(
    SETTINGS_PROPOSE_CHANGE_TOOL,
    // The kernel has already shown the change and the user approved it.
    async ({ title, arguments: args }) => {
      const key = typeof args.key === 'string' ? args.key : ''
      try {
        const change =
          args.reset === true
            ? await access.control['config.unset']({ key })
            : await access.control['config.set']({ key, value: args.value })
        const message = change.changed
          ? `${change.key} is now ${display(change.value)} (was ${display(change.previous)}).`
          : `${change.key} was already ${display(change.value)}.`
        return toolExecutionSucceeded({ title, data: change, modelContent: message })
      } catch (error) {
        return failure(title, error)
      }
    },
    {
      preview: async (args): Promise<AgentApprovalPreview | undefined> => {
        const key = typeof args.key === 'string' ? args.key : ''
        const descriptor = editableSetting(key)
        if (!descriptor) return undefined
        const current = await access.control['config.get']({ key })
        const after = args.reset === true ? descriptor.default : args.value
        const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 300) : ''
        return {
          summary: [descriptor.description, descriptor.sensitive, reason ? `Why: ${reason}` : '']
            .filter(Boolean)
            .join(' '),
          changes: [
            {
              label: key,
              before: display(current.value),
              after: `${display(after)}${args.reset === true ? ' (default)' : ''}`
            }
          ]
        }
      }
    }
  )

  handlers.register(PROVIDER_REQUEST_KEY_TOOL, async ({ title, arguments: args }) => {
    const id = typeof args.provider_instance_id === 'string' ? args.provider_instance_id : ''
    try {
      const provider = (await access.control['provider.list']({})).providers.find(
        (candidate) => candidate.id === id
      )
      if (!provider) {
        return toolExecutionFailed({
          title,
          code: 'not_found',
          message: 'No provider instance has that id. Call settings_read to list them.'
        })
      }
      if (!access.openProviderKeyPrompt(provider.id)) {
        return toolExecutionFailed({
          title,
          code: 'unsupported',
          message: 'SideKick has no window open to show the key prompt in.'
        })
      }
      const message = `Opened SideKick's key prompt for ${provider.name}. The user types the key there and saves Settings; you will not see it. When they say they are done, settings_read reports apiKeyConfigured for ${provider.id}.`
      return toolExecutionSucceeded({
        title,
        data: { providerInstanceId: provider.id, opened: true },
        modelContent: message
      })
    } catch (error) {
      return failure(title, error)
    }
  })
}
