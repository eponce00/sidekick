export interface ProjectStartHook {
  workspaceRoot: string
  command: string
  enabled: boolean
}

/** App-owned settings only. Never discover executable hooks in repository content. */
export function normalizeProjectStartHooks(value: unknown): ProjectStartHook[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 10).flatMap((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.workspaceRoot !== 'string' ||
      typeof entry.command !== 'string'
    )
      return []
    const workspaceRoot = entry.workspaceRoot.trim()
    const command = entry.command.trim()
    if (
      !workspaceRoot ||
      !command ||
      workspaceRoot.length > 4096 ||
      command.length > 8192 ||
      /[\0\r\n]/.test(workspaceRoot) ||
      command.includes('\0')
    )
      return []
    return [{ workspaceRoot, command, enabled: entry.enabled === true }]
  })
}
