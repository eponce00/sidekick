import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  availableWorkspaceServers,
  definitionsForFile,
  detectWorkspaceLanguages,
  languageIdForFile,
  resolveServerForFile
} from './serverRegistry'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('language server registry', () => {
  it('maps common source files without starting or installing anything', () => {
    expect(definitionsForFile('src/App.tsx')[0]?.id).toBe('typescript')
    expect(languageIdForFile(definitionsForFile('src/App.tsx')[0], 'src/App.tsx')).toBe(
      'typescriptreact'
    )
    expect(definitionsForFile('main.rs')[0]?.id).toBe('rust')
    expect(definitionsForFile('Dockerfile')[0]?.id).toBe('docker')
  })

  it('discovers a project-local server lazily', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-lsp-registry-'))
    roots.push(root)
    const bin = join(root, 'node_modules', '.bin')
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(bin, { recursive: true })
    await writeFile(join(root, 'src', 'index.ts'), 'export {}\n')
    const executable = join(bin, 'typescript-language-server')
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
    await chmod(executable, 0o755)

    expect(detectWorkspaceLanguages(root)).toContain('typescript')
    expect(resolveServerForFile(root, 'src/index.ts')).toMatchObject({
      id: 'typescript',
      command: executable,
      origin: 'workspace'
    })
    expect(availableWorkspaceServers(root).map(({ id }) => id)).toContain('typescript')
  })

  it('prefers a marker-specific Deno server without leaking it into ordinary TypeScript projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-lsp-deno-'))
    roots.push(root)
    const bin = join(root, 'node_modules', '.bin')
    await mkdir(bin, { recursive: true })
    for (const name of ['typescript-language-server', 'deno']) {
      const executable = join(bin, name)
      await writeFile(executable, '#!/bin/sh\nexit 0\n')
      await chmod(executable, 0o755)
    }
    await writeFile(join(root, 'main.ts'), 'export {}\n')

    expect(resolveServerForFile(root, 'main.ts')?.id).toBe('typescript')
    await writeFile(join(root, 'deno.json'), '{}\n')
    expect(resolveServerForFile(root, 'main.ts')?.id).toBe('deno')
  })
})
