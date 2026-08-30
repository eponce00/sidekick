import type { ToolExecution } from '../types/chat.types'

export interface UiContribution<TValue> {
  id: string
  priority?: number
  value: TValue
}

/** Small typed lifecycle registry; feature modules contribute without importing their consumers. */
export class UiContributionRegistry<TValue> {
  private readonly entries = new Map<string, UiContribution<TValue>>()

  register(contribution: UiContribution<TValue>): () => void {
    if (this.entries.has(contribution.id)) {
      throw new Error(`Duplicate UI contribution: ${contribution.id}`)
    }
    this.entries.set(contribution.id, contribution)
    return () => {
      if (this.entries.get(contribution.id) === contribution) this.entries.delete(contribution.id)
    }
  }

  list(): readonly UiContribution<TValue>[] {
    return [...this.entries.values()].sort(
      (left, right) => (right.priority ?? 0) - (left.priority ?? 0)
    )
  }
}

export type ToolViewKind =
  | 'generic'
  | 'terminal'
  | 'read'
  | 'diff'
  | 'search'
  | 'web'
  | 'files'
  | 'artifact'
  | 'task'
  | 'subagent'

export interface ToolViewContribution {
  matches: (tool: ToolExecution) => boolean
  view: ToolViewKind
}

export const toolViewContributions = new UiContributionRegistry<ToolViewContribution>()

toolViewContributions.register({
  id: 'sidekick.subagent-tool-view',
  priority: 100,
  value: {
    matches: (tool) => tool.presentation?.kind === 'subagent' || tool.name === 'spawn_subagent',
    view: 'subagent'
  }
})
;(['terminal', 'read', 'diff', 'search', 'web', 'files', 'artifact', 'task'] as const).forEach(
  (kind, index) =>
    toolViewContributions.register({
      id: `sidekick.${kind}-tool-view`,
      priority: 50 - index,
      value: { matches: (tool) => tool.presentation?.kind === kind, view: kind }
    })
)

toolViewContributions.register({
  id: 'sidekick.standard-tool-view',
  priority: -1_000,
  value: { matches: () => true, view: 'generic' }
})

export function resolveToolView(tool: ToolExecution): ToolViewKind {
  return (
    toolViewContributions.list().find(({ value }) => value.matches(tool))?.value.view ?? 'generic'
  )
}

export type SettingsSectionId = 'providers' | 'general' | 'agent' | 'appearance' | 'integrations'

export interface SettingsSectionContribution {
  id: SettingsSectionId
  label: string
  description: string
  icon: 'server' | 'settings' | 'bot' | 'palette' | 'boxes'
}

export const settingsSectionContributions =
  new UiContributionRegistry<SettingsSectionContribution>()

const BUILTIN_SETTINGS_SECTIONS = [
  { id: 'providers', label: 'Providers', description: 'Connections and models', icon: 'server' },
  { id: 'general', label: 'General', description: 'Messages and notifications', icon: 'settings' },
  { id: 'agent', label: 'Agent', description: 'Behavior and permissions', icon: 'bot' },
  { id: 'appearance', label: 'Appearance', description: 'Theme and color', icon: 'palette' },
  { id: 'integrations', label: 'Integrations', description: 'MCP servers', icon: 'boxes' }
] satisfies SettingsSectionContribution[]

BUILTIN_SETTINGS_SECTIONS.forEach((value) =>
  settingsSectionContributions.register({ id: `sidekick.settings.${value.id}`, value })
)
