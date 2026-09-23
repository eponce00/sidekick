import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { WorkspaceReadService } from './workspaceReadService'

const roots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-workspace-read-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('WorkspaceReadService', () => {
  it('lists project dot-entries while still skipping generated noise', async () => {
    const root = await workspace()
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci')
    await writeFile(join(root, '.gitignore'), 'node_modules')
    await writeFile(join(root, '.prettierrc.yaml'), 'semi: false')
    await writeFile(join(root, 'app.ts'), 'export {}')
    // Generated or operating-system noise stays out of the way.
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main')
    await mkdir(join(root, '__pycache__'), { recursive: true })
    await writeFile(join(root, '__pycache__', 'x.pyc'), '')
    await mkdir(join(root, '.venv'), { recursive: true })
    await writeFile(join(root, '.venv', 'pyvenv.cfg'), '')
    await writeFile(join(root, '.DS_Store'), '')
    await writeFile(join(root, '.eslintcache'), '')

    const { files } = await new WorkspaceReadService().listFiles(root, {})

    // A dot-directory that is part of the project is browsable, not hidden.
    expect(files).toContain('.github/workflows/ci.yml')
    expect(files).toEqual(expect.arrayContaining(['.gitignore', '.prettierrc.yaml', 'app.ts']))
    for (const noise of ['.DS_Store', '.eslintcache']) expect(files).not.toContain(noise)
    for (const prefix of ['.git/', '__pycache__/', '.venv/']) {
      expect(files.some((file) => file.startsWith(prefix))).toBe(false)
    }
  })

  it('returns numbered bounded reads with a continuation and version receipt', async () => {
    const root = await workspace()
    await writeFile(
      join(root, 'large.txt'),
      Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n')
    )
    const service = new WorkspaceReadService()

    const result = await service.readFile(root, 'large.txt', { startLine: 4, maxLines: 3 })

    expect(result.content).toBe('4: line 4\n5: line 5\n6: line 6')
    expect(result.totalLines).toBe(20)
    expect(result.nextLine).toBe(7)
    expect(result.truncated).toBe(true)
    expect(result.version).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects binary files', async () => {
    const root = await workspace()
    await writeFile(join(root, 'binary.bin'), Buffer.from([1, 0, 2]))
    await expect(new WorkspaceReadService().readFile(root, 'binary.bin')).rejects.toThrow('binary')
  })

  it('lists deterministically with a cursor and skips dependency trees', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'src', 'a.ts'), 'a')
    await writeFile(join(root, 'src', 'b.ts'), 'b')
    await writeFile(join(root, 'node_modules', 'ignored.js'), 'ignored')
    const service = new WorkspaceReadService()

    const first = await service.listFiles(root, { maxResults: 2 })
    const second = await service.listFiles(root, { cursor: first.nextCursor ?? 0, maxResults: 2 })

    expect(first.files).toEqual(['src/', 'src/a.ts'])
    expect(first.nextCursor).toBe(2)
    expect(second.files).toEqual(['src/b.ts'])
    expect([...first.files, ...second.files].join(' ')).not.toContain('node_modules')
  })

  it('bounds regex search and honors cancellation', async () => {
    const root = await workspace()
    await writeFile(join(root, 'one.ts'), 'alpha\nbeta\nalpha')
    const service = new WorkspaceReadService()
    const result = await service.searchFiles(root, { regex: 'alpha' })
    expect(result.matchCount).toBe(2)
    expect(result.matchedFiles).toEqual(['one.ts'])

    const controller = new AbortController()
    controller.abort()
    await expect(service.listFiles(root, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('accepts a file path as the search scope', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'one.ts'), 'needle\nonly this file')
    await writeFile(join(root, 'other.ts'), 'needle\nnot this file')

    const result = await new WorkspaceReadService().searchFiles(root, {
      regex: 'needle',
      path: 'src/one.ts'
    })

    expect(result.matchCount).toBe(1)
    expect(result.matchedFiles).toEqual(['src/one.ts'])
  })

  it('returns actionable search argument errors', async () => {
    const root = await workspace()
    const service = new WorkspaceReadService()

    await expect(service.searchFiles(root, { regex: '[invalid' })).rejects.toThrow(
      'Invalid search regular expression'
    )
    await expect(service.searchFiles(root, { regex: 'valid', path: 'missing.ts' })).rejects.toThrow(
      'Search path does not exist'
    )
  })
})
