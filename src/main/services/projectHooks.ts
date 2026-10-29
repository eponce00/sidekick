import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { normalizeProjectStartHooks } from '../../shared/projectHooks'
import type { WorkspaceFolder } from '../../shared/projects'

/** A hook command and, for one set on another of the project's folders, that folder's name. */
export interface ProjectHookCommand {
  command: string
  cwd?: string
}

function canonical(path: string): string | null {
  if (!isAbsolute(path)) return null
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * The enabled hooks for a run in this project. A hook set on the primary folder runs there; one
 * set on another of the project's folders runs in that folder. Hooks on any other folder,
 * including one inside a project folder, do not run.
 */
export function projectHookCommands(
  value: unknown,
  workspaceRoot: string | null | undefined,
  folders: readonly WorkspaceFolder[] = []
): ProjectHookCommand[] {
  const primary = workspaceRoot ? canonical(workspaceRoot) : null
  if (!primary) return []
  const extras = new Map<string, string>()
  for (const { name, path } of folders) {
    const root = canonical(path)
    if (root && root !== primary && !extras.has(root)) extras.set(root, name)
  }
  return normalizeProjectStartHooks(value).flatMap((hook) => {
    const root = hook.enabled ? canonical(hook.workspaceRoot) : null
    if (!root) return []
    if (root === primary) return [{ command: hook.command }]
    const name = extras.get(root)
    return name ? [{ command: hook.command, cwd: name }] : []
  })
}

/** The enabled hooks set on exactly this folder, as for a new worktree of it. */
export function projectStartCommands(
  value: unknown,
  workspaceRoot: string | null | undefined
): string[] {
  return projectHookCommands(value, workspaceRoot).map(({ command }) => command)
}
