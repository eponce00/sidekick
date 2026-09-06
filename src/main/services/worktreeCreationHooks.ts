export interface WorktreeHookExecution {
  success: boolean
  outputPath?: string
}

export interface WorktreeHookResult {
  status: 'skipped' | 'completed' | 'denied' | 'failed'
  completed: number
  outputPaths: string[]
}

/** Explicit app-owned commands only. Never retry an uncertain side effect. */
export async function runWorktreeCreationHooks(input: {
  commands: readonly string[]
  approve: (command: string) => Promise<boolean>
  execute: (command: string) => Promise<WorktreeHookExecution>
}): Promise<WorktreeHookResult> {
  const commands = [...input.commands].slice(0, 10)
  const outcome: WorktreeHookResult = { status: 'skipped', completed: 0, outputPaths: [] }
  for (const command of commands) {
    try {
      if (!(await input.approve(command))) return { ...outcome, status: 'denied' }
      const result = await input.execute(command)
      if (result.outputPath) outcome.outputPaths.push(result.outputPath)
      if (!result.success) return { ...outcome, status: 'failed' }
      outcome.completed++
    } catch {
      // Raw process errors can contain environment values. The command's private
      // output file, not a public diagnostic or generic IPC error, holds detail.
      return { ...outcome, status: 'failed' }
    }
  }
  return { ...outcome, status: commands.length ? 'completed' : 'skipped' }
}
