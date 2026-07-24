import { afterEach, describe, expect, it } from 'vitest'
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeWorkspaceMutation, previewWorkspaceMutation } from './workspaceMutationService'
import { WorkspaceReadService } from './workspaceReadService'

const temporaryRoots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-mutations-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('workspace mutation service', () => {
  it.each([
    '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new',
    '-old\n+new',
    'old\nnew'
  ])('rejects non-canonical patch input without touching the file', async (patch) => {
    const root = await workspace()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/app.ts'), 'old\n', 'utf8')

    const result = await executeWorkspaceMutation(root, {
      kind: 'apply-patch',
      patch,
      accessLevel: 'auto'
    })

    expect(result).toMatchObject({ ok: false, changed: false, files: [] })
    expect(result.error).toContain('*** Begin Patch')
    expect(await readFile(join(root, 'src/app.ts'), 'utf8')).toBe('old\n')
  })

  it('applies and verifies a canonical multi-file patch', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/app.ts'), 'export const before = true\nexport const keep = 1\n')
    await writeFile(join(root, 'src/obsolete.ts'), 'obsolete\n')

    const result = await executeWorkspaceMutation(root, {
      kind: 'apply-patch',
      accessLevel: 'auto',
      patch: `*** Begin Patch
*** Update File: src/app.ts
@@
-export const before = true
+export const after = true
 export const keep = 1
*** Add File: src/new.ts
+export const created = true
*** Delete File: src/obsolete.ts
*** End Patch`
    })

    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.files.map(({ action }) => action)).toEqual(['update', 'add', 'delete'])
    expect(result.diff).toContain('+++ b/src/app.ts')
    expect(result.files.every(({ afterHash, action }) => action === 'delete' || afterHash)).toBe(
      true
    )
    expect(await readFile(join(root, 'src/app.ts'), 'utf8')).toContain('after = true')
    expect(await readFile(join(root, 'src/new.ts'), 'utf8')).toBe('export const created = true\n')
    await expect(readFile(join(root, 'src/obsolete.ts'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rolls back earlier files and newly created directories when a later commit fails', async () => {
    const root = await workspace()

    const result = await executeWorkspaceMutation(root, {
      kind: 'apply-patch',
      accessLevel: 'auto',
      patch: `*** Begin Patch
*** Add File: generated/parent.txt
+parent
*** Add File: generated/parent.txt/child.txt
+child
*** End Patch`
    })

    expect(result).toMatchObject({ ok: false, changed: false, files: [] })
    await expect(lstat(join(root, 'generated'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects missing and ambiguous exact replacements', async () => {
    const root = await workspace()
    await writeFile(join(root, 'values.txt'), 'same\nsame\n', 'utf8')

    const ambiguous = await executeWorkspaceMutation(root, {
      kind: 'replace',
      filePath: 'values.txt',
      oldText: 'same',
      newText: 'different',
      replaceAll: false,
      accessLevel: 'auto'
    })
    const missing = await executeWorkspaceMutation(root, {
      kind: 'replace',
      filePath: 'values.txt',
      oldText: 'missing',
      newText: 'different',
      replaceAll: false,
      accessLevel: 'auto'
    })

    expect(ambiguous).toMatchObject({ ok: false, changed: false })
    expect(ambiguous.error).toContain('2 matches')
    expect(ambiguous.failure).toEqual({
      code: 'multiple_matches',
      recovery:
        'Choose the replacement scope explicitly: set replace_all=true for every match, or add surrounding lines to old_string for one unique match. Do not repeat the unchanged call.',
      matchCount: 2,
      matchStartLines: [1, 2]
    })
    expect(missing.error).toContain('was not found')
    expect(await readFile(join(root, 'values.txt'), 'utf8')).toBe('same\nsame\n')
  })

  it('adapts exact multi-line edits to the file line ending without changing its style', async () => {
    const root = await workspace()
    await writeFile(join(root, 'windows.txt'), 'first\r\nsecond\r\nthird\r\n', 'utf8')

    const result = await executeWorkspaceMutation(root, {
      kind: 'replace',
      filePath: 'windows.txt',
      oldText: 'first\nsecond',
      newText: 'updated\nsecond',
      replaceAll: false,
      accessLevel: 'auto'
    })

    expect(result).toMatchObject({ ok: true, changed: true })
    expect(await readFile(join(root, 'windows.txt'), 'utf8')).toBe('updated\r\nsecond\r\nthird\r\n')
  })

  it('serializes concurrent edits so a stale second mutation fails', async () => {
    const root = await workspace()
    await writeFile(join(root, 'counter.txt'), 'zero\n', 'utf8')
    const request = (newText: string) =>
      executeWorkspaceMutation(root, {
        kind: 'replace' as const,
        filePath: 'counter.txt',
        oldText: 'zero',
        newText,
        replaceAll: false,
        accessLevel: 'auto' as const
      })

    const results = await Promise.all([request('one'), request('two')])

    expect(results.filter(({ ok }) => ok)).toHaveLength(1)
    expect(results.filter(({ ok }) => !ok)[0].error).toContain('was not found')
    expect(['one\n', 'two\n']).toContain(await readFile(join(root, 'counter.txt'), 'utf8'))
  })

  it('requires a current run-scoped read receipt for agent changes to existing files', async () => {
    const root = await workspace()
    await writeFile(join(root, 'receipt.txt'), 'before\n', 'utf8')
    const reads = new WorkspaceReadService()
    const receipt = await reads.readFile(root, 'receipt.txt')
    const request = {
      kind: 'replace' as const,
      filePath: 'receipt.txt',
      oldText: 'before',
      newText: 'after',
      replaceAll: false,
      accessLevel: 'auto' as const
    }

    expect(
      await executeWorkspaceMutation(root, request, { requireReadReceipt: true })
    ).toMatchObject({ ok: false, error: expect.stringContaining('Read receipt required') })

    await writeFile(join(root, 'receipt.txt'), 'changed elsewhere\n', 'utf8')
    const changedRequest = { ...request, oldText: 'changed elsewhere' }
    expect(
      await executeWorkspaceMutation(root, changedRequest, {
        requireReadReceipt: true,
        expectedVersions: { 'receipt.txt': receipt.version }
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining('Stale read receipt') })

    const current = await reads.readFile(root, 'receipt.txt')
    const currentRequest = changedRequest
    expect(
      await executeWorkspaceMutation(root, currentRequest, {
        requireReadReceipt: true,
        expectedVersions: { 'receipt.txt': current.version }
      })
    ).toMatchObject({ ok: true, changed: true })
  })

  it('rejects no-op writes during preview and execution', async () => {
    const root = await workspace()
    await writeFile(join(root, 'same.txt'), 'unchanged', 'utf8')
    const request = {
      kind: 'write' as const,
      filePath: 'same.txt',
      content: 'unchanged',
      accessLevel: 'auto' as const
    }

    expect(await previewWorkspaceMutation(root, request)).toMatchObject({
      ok: false,
      changed: false,
      error: expect.stringContaining('identical content')
    })
    expect(await executeWorkspaceMutation(root, request)).toMatchObject({
      ok: false,
      changed: false
    })
  })

  it('blocks writes through a symlink that escapes the project', async () => {
    const root = await workspace()
    const outside = await workspace()
    await symlink(
      outside,
      join(root, 'outside-link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    const result = await executeWorkspaceMutation(root, {
      kind: 'write',
      filePath: 'outside-link/escaped.txt',
      content: 'blocked',
      accessLevel: 'auto'
    })

    expect(result).toMatchObject({ ok: false, changed: false })
    expect(result.error).toContain('escapes the project root')
    await expect(readFile(join(outside, 'escaped.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rejects internal symlink aliases instead of mutating their targets', async () => {
    const root = await workspace()
    await mkdir(join(root, 'target-directory'))
    await writeFile(join(root, 'target-directory/target.txt'), 'original', 'utf8')
    await symlink(
      join(root, 'target-directory'),
      join(root, 'alias-directory'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    const result = await executeWorkspaceMutation(root, {
      kind: 'write',
      filePath: 'alias-directory/target.txt',
      content: 'replacement',
      accessLevel: 'auto'
    })

    expect(result).toMatchObject({ ok: false, changed: false })
    expect(result.error).toContain('Symbolic-link mutation paths are not supported')
    expect(await readFile(join(root, 'target-directory/target.txt'), 'utf8')).toBe('original')
    expect((await lstat(join(root, 'alias-directory'))).isSymbolicLink()).toBe(true)
  })

  it('rejects two patch paths that resolve to the same file', async () => {
    const root = await workspace()
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'same.txt'), 'first\nsecond\n', 'utf8')

    const result = await executeWorkspaceMutation(root, {
      kind: 'apply-patch',
      accessLevel: 'auto',
      patch: `*** Begin Patch
*** Update File: same.txt
@@
-first
+changed
 second
*** Update File: nested/../same.txt
@@
 first
-second
+changed
*** End Patch`
    })

    expect(result).toMatchObject({ ok: false, changed: false })
    expect(result.error).toContain('resolved path is modified more than once')
    expect(await readFile(join(root, 'same.txt'), 'utf8')).toBe('first\nsecond\n')
  })

  it('preserves executable permissions when moving and editing a file', async () => {
    const root = await workspace()
    await mkdir(join(root, 'bin'))
    await writeFile(join(root, 'bin/start.sh'), '#!/bin/sh\necho old\n', 'utf8')
    await chmod(join(root, 'bin/start.sh'), 0o755)
    const originalMode = (await stat(join(root, 'bin/start.sh'))).mode & 0o777

    const result = await executeWorkspaceMutation(root, {
      kind: 'apply-patch',
      accessLevel: 'auto',
      patch: `*** Begin Patch
*** Update File: bin/start.sh
*** Move to: scripts/start.sh
@@
 #!/bin/sh
-echo old
+echo new
*** End Patch`
    })

    expect(result).toMatchObject({ ok: true, changed: true })
    expect((await stat(join(root, 'scripts/start.sh'))).mode & 0o777).toBe(originalMode)
    expect(await readFile(join(root, 'scripts/start.sh'), 'utf8')).toContain('echo new')
    await expect(readFile(join(root, 'bin/start.sh'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rejects ambiguous patch markers', async () => {
    const root = await workspace()
    await writeFile(join(root, 'repeated.ts'), 'function target() {}\nfunction target() {}\n')

    const result = await executeWorkspaceMutation(root, {
      kind: 'apply-patch',
      accessLevel: 'auto',
      patch: `*** Begin Patch
*** Update File: repeated.ts
@@ function target
+const inserted = true
*** End Patch`
    })

    expect(result).toMatchObject({ ok: false, changed: false })
    expect(result.error).toContain('@@ marker is ambiguous')
  })

  it('bounds large diff previews while preserving exact change counts', async () => {
    const root = await workspace()
    const before = Array.from({ length: 20_000 }, (_, index) => `before-${index}`).join('\n')
    const after = Array.from({ length: 20_000 }, (_, index) => `after-${index}`).join('\n')
    await writeFile(join(root, 'large.txt'), before)

    const result = await previewWorkspaceMutation(root, {
      kind: 'write',
      filePath: 'large.txt',
      content: after,
      accessLevel: 'auto'
    })

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      additions: 20_000,
      deletions: 20_000,
      diffTruncated: true
    })
    expect(result.diff.length).toBeLessThan(65_000)
    expect(result.diff).toContain('exact totals: +20000 -20000')
  })

  it('represents a trailing-newline-only edit truthfully', async () => {
    const root = await workspace()
    await writeFile(join(root, 'newline.txt'), 'value\n')

    const result = await previewWorkspaceMutation(root, {
      kind: 'write',
      filePath: 'newline.txt',
      content: 'value',
      accessLevel: 'auto'
    })

    expect(result).toMatchObject({ ok: true, changed: true, additions: 1, deletions: 1 })
    expect(result.diff).toContain('-value')
    expect(result.diff).toContain('+value')
    expect(result.diff).toContain('\\ No newline at end of file')
  })
})
