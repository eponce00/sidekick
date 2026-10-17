/**
 * Settings that tools outside the Settings window (the `sidekick` CLI, and later SideKick's own
 * agent) may read and change. Anything absent here, such as credentials, provider instances,
 * hooks, and executable paths, cannot be written through those paths at all.
 */
import {
  DEFAULT_TOOL_CALL_LIMIT,
  MAX_TOOL_CALL_LIMIT,
  MIN_TOOL_CALL_LIMIT,
  TOOL_CALL_LIMIT_POLICY_VERSION
} from './agentLimits'
import type { ProviderSettings, PublicProviderSettings } from './settings'

export type EditableSettingValue = boolean | number | string

interface DescriptorBase {
  key: string
  section: 'agent' | 'models' | 'general' | 'appearance' | 'notifications'
  description: string
  /** Weakening this setting shows SideKick's approval dialog before it is applied. */
  sensitive?: string
  /** Written alongside the value so the app treats it as current. */
  companions?: Record<string, EditableSettingValue>
}

export type EditableSettingDescriptor = DescriptorBase &
  (
    | { type: 'boolean'; default: boolean }
    | { type: 'integer' | 'number'; default: number; min: number; max: number }
    | { type: 'enum'; default: string; values: readonly string[] }
    | { type: 'string'; default: string; maxLength: number }
    /** A configured model id (`transport:instance/model`), or empty for the default. */
    | { type: 'model'; default: '' }
  )

// Defaults mirror what the app applies when a setting is unset.
export const EDITABLE_SETTINGS: readonly EditableSettingDescriptor[] = [
  {
    key: 'commandPermissionMode',
    section: 'agent',
    type: 'enum',
    values: ['always-ask', 'sensitive-only', 'full-access'],
    default: 'full-access',
    description: 'Which agent operations ask for approval before they run.',
    sensitive: 'Switching to full-access needs approval in SideKick.'
  },
  {
    key: 'shellIsolation',
    section: 'agent',
    type: 'enum',
    values: ['host', 'docker'],
    default: 'host',
    description: 'Run agent shell commands on this computer or inside a Docker container.',
    sensitive: 'Leaving docker needs approval in SideKick.'
  },
  {
    key: 'toolCallLimit',
    section: 'agent',
    type: 'integer',
    min: MIN_TOOL_CALL_LIMIT,
    max: MAX_TOOL_CALL_LIMIT,
    default: DEFAULT_TOOL_CALL_LIMIT,
    description: 'Most tool calls the agent makes in one reply before it stops to check in.',
    companions: { toolCallLimitVersion: TOOL_CALL_LIMIT_POLICY_VERSION }
  },
  {
    key: 'focusChainEnabled',
    section: 'agent',
    type: 'boolean',
    default: true,
    description: 'Remind the agent of its task list during long runs.'
  },
  {
    key: 'autoCompactEnabled',
    section: 'agent',
    type: 'boolean',
    default: true,
    description: 'Summarize older conversation turns when the context window fills.'
  },
  {
    key: 'autoCompactThreshold',
    section: 'agent',
    type: 'number',
    min: 0.5,
    max: 0.95,
    default: 0.8,
    description: 'Fraction of the context window that triggers compaction.'
  },
  {
    key: 'webSearchEnabled',
    section: 'agent',
    type: 'boolean',
    default: true,
    description: 'Let the agent search the web through public search engines.'
  },
  {
    key: 'selectedModel',
    section: 'models',
    type: 'model',
    default: '',
    description: 'Model used for new chats. See `sidekick doctor` for configured providers.'
  },
  {
    key: 'planningModelId',
    section: 'models',
    type: 'model',
    default: '',
    description: 'Model used for Plan mode; empty uses the chat model.'
  },
  {
    key: 'voiceEnabled',
    section: 'general',
    type: 'boolean',
    default: true,
    description: 'Local dictation and read-aloud, including the background model download.'
  },
  {
    key: 'automaticUpdateChecks',
    section: 'general',
    type: 'boolean',
    default: true,
    description: 'Check GitHub Releases for updates after startup and every six hours.'
  },
  {
    key: 'closeToTray',
    section: 'general',
    type: 'boolean',
    default: true,
    description:
      'Windows and Linux: closing the window keeps SideKick in the tray so agents keep working.'
  },
  {
    key: 'manualLocation',
    section: 'general',
    type: 'string',
    maxLength: 200,
    default: '',
    description: 'City the agent uses for local answers; empty sends only your time zone.'
  },
  {
    key: 'contentFontSize',
    section: 'appearance',
    type: 'integer',
    min: 12,
    max: 17,
    default: 13,
    description: 'Conversation text size in pixels.'
  },
  {
    key: 'notificationsEnabled',
    section: 'notifications',
    type: 'boolean',
    default: true,
    description: 'Show a desktop notification when a reply finishes in the background.'
  },
  {
    key: 'notificationSoundEnabled',
    section: 'notifications',
    type: 'boolean',
    default: false,
    description: 'Play a sound with notifications.'
  },
  {
    key: 'maxConcurrentRuns',
    section: 'agent',
    type: 'integer',
    min: 1,
    max: 8,
    default: 4,
    description: 'Chats, scheduled runs and sub-agents that may work at once; more wait in a queue.'
  }
]

// Typed as a complete record so a new setting cannot be added without listing it here.
const KNOWN_STORED_KEYS: Record<keyof ProviderSettings | keyof PublicProviderSettings, true> = {
  maxConcurrentRuns: true,
  shellIsolation: true,
  officeHelperInterpreter: true,
  officeHelperConfigurationId: true,
  projectStartHooks: true,
  projectCompletionHooks: true,
  projectWorktreeHooks: true,
  providerInstances: true,
  openRouterApiKey: true,
  openRouterApiKeyConfigured: true,
  ollamaEndpoint: true,
  ollamaCloudApiKey: true,
  ollamaCloudApiKeyConfigured: true,
  ollamaCloudBaseUrl: true,
  lmStudioEndpoint: true,
  lmStudioApiKey: true,
  lmStudioApiKeyConfigured: true,
  llamaCppEndpoint: true,
  selectedModel: true,
  planningModelId: true,
  accentPalette: true,
  contentFontSize: true,
  focusChainEnabled: true,
  autoCompactEnabled: true,
  autoCompactThreshold: true,
  notificationsEnabled: true,
  notificationSoundEnabled: true,
  voiceEnabled: true,
  webSearchEnabled: true,
  automaticUpdateChecks: true,
  manualLocation: true,
  fastModelOllama: true,
  fastModelOllamaCloud: true,
  fastModelOpenRouter: true,
  fastModelAnthropic: true,
  fastModelLMStudio: true,
  fastModelLlamaCpp: true,
  ollamaThinkingEnabled: true,
  openRouterThinkingEnabled: true,
  toolCallLimit: true,
  toolCallLimitVersion: true,
  commandPermissionMode: true,
  mcpServers: true,
  closeToTray: true
}
/**
 * Settings SideKick no longer has. Startup removes them from the stored settings: agent commands
 * always run in a terminal now (falling back to pipes where one cannot start), and the task-list
 * reminder interval was never read.
 */
export const RETIRED_SETTING_KEYS = ['agentCommandTerminal', 'focusChainReminderInterval'] as const

// Encrypted credentials, written only by the main process.
const INTERNAL_STORED_KEYS = new Set([
  '__encryptedSecrets',
  '__encryptedProviderSecrets',
  '__encryptedMcpEnv'
])

/** Whether a key found in the stored settings is one SideKick reads. */
export function isKnownStoredSettingKey(key: string): boolean {
  return Object.hasOwn(KNOWN_STORED_KEYS, key) || INTERNAL_STORED_KEYS.has(key)
}

const BY_KEY = new Map(EDITABLE_SETTINGS.map((descriptor) => [descriptor.key, descriptor]))

export function editableSetting(key: string): EditableSettingDescriptor | undefined {
  return BY_KEY.get(key)
}

export type SettingValidation =
  | { ok: true; value: EditableSettingValue }
  | { ok: false; reason: string }

/**
 * Accepts a typed JSON value, or the string a command line passes, and returns the value to
 * store. Model ids are checked against `configuredModelIds` when it is given.
 */
export function validateSettingValue(
  descriptor: EditableSettingDescriptor,
  input: unknown,
  configuredModelIds?: readonly string[]
): SettingValidation {
  switch (descriptor.type) {
    case 'boolean': {
      if (typeof input === 'boolean') return { ok: true, value: input }
      if (input === 'true') return { ok: true, value: true }
      if (input === 'false') return { ok: true, value: false }
      return { ok: false, reason: 'expected true or false' }
    }
    case 'integer':
    case 'number': {
      const parsed =
        typeof input === 'number'
          ? input
          : typeof input === 'string' && input.trim() !== ''
            ? Number(input)
            : Number.NaN
      if (!Number.isFinite(parsed)) return { ok: false, reason: 'expected a number' }
      if (descriptor.type === 'integer' && !Number.isInteger(parsed)) {
        return { ok: false, reason: 'expected a whole number' }
      }
      if (parsed < descriptor.min || parsed > descriptor.max) {
        return { ok: false, reason: `expected ${descriptor.min} to ${descriptor.max}` }
      }
      return { ok: true, value: parsed }
    }
    case 'enum': {
      if (typeof input === 'string' && descriptor.values.includes(input)) {
        return { ok: true, value: input }
      }
      return { ok: false, reason: `expected one of ${descriptor.values.join(', ')}` }
    }
    case 'string': {
      if (typeof input !== 'string') return { ok: false, reason: 'expected text' }
      if (input.length > descriptor.maxLength) {
        return { ok: false, reason: `longer than ${descriptor.maxLength} characters` }
      }
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(input)) {
        return { ok: false, reason: 'contains control characters' }
      }
      return { ok: true, value: input }
    }
    case 'model': {
      if (input === '') return { ok: true, value: '' }
      if (typeof input !== 'string') return { ok: false, reason: 'expected a model id' }
      if (configuredModelIds && !configuredModelIds.includes(input)) {
        return { ok: false, reason: 'not a configured, enabled model' }
      }
      return { ok: true, value: input }
    }
  }
}

function describeType(descriptor: EditableSettingDescriptor): string {
  switch (descriptor.type) {
    case 'boolean':
      return '`true` or `false`'
    case 'integer':
      return `whole number, ${descriptor.min} to ${descriptor.max}`
    case 'number':
      return `number, ${descriptor.min} to ${descriptor.max}`
    case 'enum':
      return descriptor.values.map((value) => `\`${value}\``).join(', ')
    case 'string':
      return `text, up to ${descriptor.maxLength} characters`
    case 'model':
      return 'configured model id, or empty'
  }
}

/** The llms.txt-style reference agents read before changing SideKick's configuration. */
export function renderSettingsReference(): string {
  const lines = [
    '# SideKick settings',
    '',
    '> Settings the `sidekick` CLI can read and change. Provider API keys are not settings: store',
    '> one with `sidekick auth set <provider-instance> --stdin`. No command ever prints a key.',
    '',
    'Change a setting with `sidekick config set <key> <value>` and return it to its default with',
    '`sidekick config unset <key>`. Add `--json` for machine-readable output. Settings marked',
    'sensitive wait for the user to approve the change in SideKick.',
    ''
  ]
  const sections = [...new Set(EDITABLE_SETTINGS.map((descriptor) => descriptor.section))]
  for (const section of sections) {
    lines.push(`## ${section[0].toUpperCase()}${section.slice(1)}`, '')
    for (const descriptor of EDITABLE_SETTINGS.filter((item) => item.section === section)) {
      const fallback = descriptor.default === '' ? 'empty' : `\`${String(descriptor.default)}\``
      lines.push(
        `- \`${descriptor.key}\`: ${descriptor.description} Values: ${describeType(descriptor)}. Default: ${fallback}.${descriptor.sensitive ? ` Sensitive: ${descriptor.sensitive}` : ''}`
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}
