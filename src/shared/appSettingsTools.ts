/**
 * Tools that let SideKick's own agent inspect and change SideKick. Reads are free; a change goes
 * through an approval card with a before-and-after view every time, whatever the permission
 * mode. None of them can read or set a credential: the agent asks the user to enter a key in
 * SideKick's own prompt instead.
 */
import type { AgentToolDefinition } from './agentToolDefinitions'

export const SETTINGS_READ_TOOL = 'settings_read'
export const SETTINGS_REFERENCE_TOOL = 'settings_reference'
export const SETTINGS_PROPOSE_CHANGE_TOOL = 'settings_propose_change'
export const PROVIDER_REQUEST_KEY_TOOL = 'provider_request_key'

export const settingsReadTool: AgentToolDefinition = {
  type: 'function',
  function: {
    name: SETTINGS_READ_TOOL,
    description:
      "Read SideKick's current configuration: changeable settings with their values, provider instances (whether each has a key, never the key), and MCP connectors (whether each is approved). Never returns a secret.",
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['all', 'settings', 'providers', 'mcp'],
          description: 'What to read; defaults to all.'
        }
      }
    }
  }
}

export const settingsReferenceTool: AgentToolDefinition = {
  type: 'function',
  function: {
    name: SETTINGS_REFERENCE_TOOL,
    description:
      'Return the reference for every setting you can propose changing: its type, allowed values, default, and whether the user must approve weakening it.',
    parameters: { type: 'object', properties: {} }
  }
}

export const settingsProposeChangeTool: AgentToolDefinition = {
  type: 'function',
  function: {
    name: SETTINGS_PROPOSE_CHANGE_TOOL,
    description:
      'Propose changing one SideKick setting. The user sees the current and proposed value and must approve each change. Only settings from settings_reference can change; credentials, providers, and connectors cannot.',
    parameters: {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string', description: 'Setting key from settings_reference.' },
        value: {
          type: 'string',
          description: 'New value as text, such as true, 120, or always-ask. Omit with reset.'
        },
        reset: {
          type: 'boolean',
          description: 'Return the setting to its default instead of setting a value.'
        },
        reason: {
          type: 'string',
          description: 'One sentence the user sees explaining why this helps.'
        }
      }
    }
  }
}

export const providerRequestKeyTool: AgentToolDefinition = {
  type: 'function',
  function: {
    name: PROVIDER_REQUEST_KEY_TOOL,
    description:
      "Open SideKick's own API key prompt for a provider instance so the user can type the key there. You never see the key; afterwards settings_read reports whether one is stored. Never ask the user to paste a key into the conversation.",
    parameters: {
      type: 'object',
      required: ['provider_instance_id'],
      properties: {
        provider_instance_id: {
          type: 'string',
          description: 'Provider instance id from settings_read.'
        }
      }
    }
  }
}
