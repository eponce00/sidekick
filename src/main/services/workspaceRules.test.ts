import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  beginWorkspaceInstructionScope,
  clearWorkspaceInstructionScope,
  loadWorkspaceRules,
  resetWorkspaceInstructionScope,
  resolveWorkspaceInstructionsForPath
} from './workspaceRules'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

async function createWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'sidekick-rules-'))
  tempRoots.push(root)
  return root
}

describe('loadWorkspaceRules', () => {
  it('loads supported workspace instruction files in deterministic order', async () => {
    const root = await createWorkspace()
    await fs.mkdir(join(root, '.sidekick'))
    await fs.writeFile(join(root, 'AGENTS.md'), 'Run tests before shipping.')
    await fs.writeFile(join(root, 'SIDEKICK.md'), 'Prefer concise UI copy.')
    await fs.writeFile(join(root, '.sidekick', 'rules.md'), 'Never expose secrets.')

    const result = await loadWorkspaceRules(root, root, { includeGlobal: false })

    expect(result.sources).toEqual(['SIDEKICK.md', '.sidekick/rules.md', 'AGENTS.md'])
    expect(result.content).toContain('Run tests before shipping.')
    expect(result.content).toContain('Never expose secrets.')
  })

  it('returns an empty result when no rule files exist', async () => {
    const root = await createWorkspace()
    const result = await loadWorkspaceRules(root, root, { includeGlobal: false })
    expect(result).toEqual({ content: '', sources: [], sourceDetails: [], truncated: false })
  })

  it('prefers AGENTS.override.md over AGENTS.md in the same directory', async () => {
    const root = await createWorkspace()
    await fs.writeFile(join(root, 'AGENTS.md'), 'Base instructions')
    await fs.writeFile(join(root, 'AGENTS.override.md'), 'Override instructions')

    const result = await loadWorkspaceRules(root, root, { includeGlobal: false })

    expect(result.sources).toEqual(['AGENTS.override.md'])
    expect(result.content).toContain('Override instructions')
    expect(result.content).not.toContain('Base instructions')
  })

  it('layers AGENTS instructions from the project root to the working directory', async () => {
    const root = await createWorkspace()
    const featureDirectory = join(root, 'packages', 'desktop')
    await fs.mkdir(featureDirectory, { recursive: true })
    await fs.writeFile(join(root, 'AGENTS.md'), 'Project-wide rules')
    await fs.writeFile(join(featureDirectory, 'AGENTS.md'), 'Desktop package rules')

    const result = await loadWorkspaceRules(root, featureDirectory, { includeGlobal: false })

    expect(result.sources).toEqual(['AGENTS.md', 'packages/desktop/AGENTS.md'])
    expect(result.content.indexOf('Project-wide rules')).toBeLessThan(
      result.content.indexOf('Desktop package rules')
    )
  })

  it('loads one global instruction layer before project instructions', async () => {
    const root = await createWorkspace()
    const home = await createWorkspace()
    await fs.mkdir(join(home, '.sidekick'))
    await fs.writeFile(join(home, '.sidekick', 'AGENTS.md'), 'Personal defaults')
    await fs.writeFile(join(root, 'AGENTS.md'), 'Project rules')

    const result = await loadWorkspaceRules(root, root, { homeDirectory: home })

    expect(result.sources).toEqual(['~/.sidekick/AGENTS.md', 'AGENTS.md'])
    expect(result.sourceDetails.map(({ kind }) => kind)).toEqual(['global', 'project'])
  })

  it('delivers nested instructions once and requires a retry before mutation', async () => {
    const root = await createWorkspace()
    const nested = join(root, 'src', 'feature')
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(join(root, 'AGENTS.md'), 'Root rules')
    await fs.writeFile(join(nested, 'AGENTS.md'), 'Feature rules')
    const scopeId = `test:${root}`
    await beginWorkspaceInstructionScope(scopeId, root)

    const first = await resolveWorkspaceInstructionsForPath(
      scopeId,
      root,
      'src/feature/file.ts',
      false,
      true
    )
    const duplicate = await resolveWorkspaceInstructionsForPath(
      scopeId,
      root,
      'src/feature/other.ts'
    )
    resetWorkspaceInstructionScope(scopeId)
    const afterCompaction = await resolveWorkspaceInstructionsForPath(
      scopeId,
      root,
      'src/feature/file.ts'
    )
    clearWorkspaceInstructionScope(scopeId)

    expect(first.sources).toEqual(['src/feature/AGENTS.md'])
    expect(first.retryRequired).toBe(true)
    expect(duplicate.content).toBe('')
    expect(afterCompaction.sources).toEqual(['src/feature/AGENTS.md'])
  })
})
