import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { normalizeProjectStartHooks } from '../../shared/projectHooks'

export function projectStartCommands(
  value: unknown,
  workspaceRoot: string | null | undefined
): string[] {
  if (!workspaceRoot || !isAbsolute(workspaceRoot)) return []
  try {
    const canonical = realpathSync(workspaceRoot)
    return normalizeProjectStartHooks(value)
      .filter((hook) => {
        if (!hook.enabled || !isAbsolute(hook.workspaceRoot)) return false
        try {
          return realpathSync(hook.workspaceRoot) === canonical
        } catch {
          return false
        }
      })
      .map((hook) => hook.command)
  } catch {
    return []
  }
}
