import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { projectStartCommands } from './projectHooks'

it('selects only enabled exact project matches, not relative paths or subprojects', () => {
  const root = mkdtempSync(join(tmpdir(), 'sidekick-hooks-'))
  try {
    const child = join(root, 'child')
    mkdirSync(child)
    const hooks = [
      { workspaceRoot: root, command: 'echo allowed', enabled: true },
      { workspaceRoot: root, command: 'echo disabled', enabled: false },
      { workspaceRoot: '.', command: 'echo relative', enabled: true }
    ]
    expect(projectStartCommands(hooks, root)).toEqual(['echo allowed'])
    expect(projectStartCommands(hooks, child)).toEqual([])
    expect(projectStartCommands(hooks, undefined)).toEqual([])
    expect(projectStartCommands({ command: 'echo invalid' }, root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
