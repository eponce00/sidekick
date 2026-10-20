import type { ProviderSettings } from '../types/app.types'

/**
 * The settings that differ between `before` and `after`, so a save names only what it changes and
 * keeps a setting changed elsewhere in the meantime. A setting `after` drops is sent as undefined,
 * which clears it.
 */
export function changedSettings(
  before: ProviderSettings,
  after: ProviderSettings
): Partial<ProviderSettings> {
  const previous = before as unknown as Record<string, unknown>
  const next = after as unknown as Record<string, unknown>
  const changes: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes[key] = next[key]
  }
  return changes as Partial<ProviderSettings>
}
