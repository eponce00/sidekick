import { expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runWorktreeCreationHooks } from './worktreeCreationHooks'
import { CommandRunner } from './commandRunner'
import { shellChildEnvironment } from './commandService'

it('runs only approved commands in order and snapshots the command list', async () => {
  const commands = ['first', 'second']
  const order: string[] = []
  const result = await runWorktreeCreationHooks({
    commands,
    approve: async (command) => {
      order.push('approve:' + command)
      commands[1] = 'replaced'
      return true
    },
    execute: async (command) => {
      order.push('execute:' + command)
      return { success: true, outputPath: command + '.log' }
    }
  })
  expect(order).toEqual(['approve:first', 'execute:first', 'approve:second', 'execute:second'])
  expect(result).toEqual({
    status: 'completed',
    completed: 2,
    outputPaths: ['first.log', 'second.log']
  })
})

it.each(['deny', 'failure', 'throw'] as const)(
  'stops on %s without retrying or running later setup',
  async (mode) => {
    const execute = vi.fn(async () => {
      if (mode === 'throw') throw new Error('sensitive fixture detail')
      return { success: false, outputPath: 'private.log' }
    })
    const result = await runWorktreeCreationHooks({
      commands: ['first', 'never'],
      approve: async () => mode !== 'deny',
      execute
    })
    expect(result.status).toBe(mode === 'deny' ? 'denied' : 'failed')
    expect(result.completed).toBe(0)
    expect(execute).toHaveBeenCalledTimes(mode === 'deny' ? 0 : 1)
    expect(JSON.stringify(result)).not.toContain('sensitive')
  }
)

it('runs a real approved command in a disposable checkout and captures its output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sidekick-setup-hook-'))
  const runner = new CommandRunner()
  try {
    const outputPath = join(root, 'private.log')
    const result = await runWorktreeCreationHooks({
      commands: ['echo setup-verified'],
      approve: async () => true,
      execute: async (command) =>
        runner.run({
          id: 'fixture',
          command,
          cwd: root,
          timeoutMs: 10000,
          outputPath,
          env: shellChildEnvironment(process.env, root, root)
        })
    })
    expect(result.status).toBe('completed')
    expect(readFileSync(outputPath, 'utf8')).toContain('setup-verified')
  } finally {
    runner.cancelAll()
    rmSync(root, { recursive: true, force: true })
  }
})
