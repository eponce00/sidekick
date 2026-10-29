import { afterEach, describe, expect, it } from 'vitest'
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { setWorkspaceFolderLookup, workspacePathKey } from '../utils/workspacePaths'
import { executeWorkspaceMutation, previewWorkspaceMutation } from './workspaceMutationService'
import { credentialRedactor } from './credentialRedaction'
import { WorkspaceReadService } from './workspaceReadService'

const temporaryRoots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-mutations-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  setWorkspaceFolderLookup(() => [])
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('workspace mutation service', () => {
  it('refuses to write a placeholder over the stored value it stands for', async () => {
    const root = await workspace()
    const value = `sk${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
    await writeFile(join(root, '.env'), `API_KEY=${value}\nDEBUG=0\n`, 'utf8')
    credentialRedactor.setSecrets([{ alias: 'api-key', value }])
    try {
      for (const request of [
        {
          kind: 'write' as const,
          filePath: '.env',
          content: 'API_KEY=[secret: api-key]\nDEBUG=1\n'
        },
        {
          kind: 'replace' as const,
          filePath: '.env',
          oldText: 'API_KEY=[secret: api-key]\nDEBUG=0',
          newText: 'API_KEY=[secret: api-key]\nDEBUG=1',
          replaceAll: false
        },
        {
          kind: 'apply-patch' as const,
          patch:
            '*** Begin Patch\n*** Update File: .env\n@@\n API_KEY=[secret: api-key]\n-DEBUG=0\n+DEBUG=1\n*** End Patch'
        }
      ]) {
        const result = await executeWorkspaceMutation(root, { ...request, accessLevel: 'auto' })
        expect(result, request.kind).toMatchObject({
          ok: false,
          changed: false,
          failure: { code: 'secret_placeholder' }
        })
      }
      expect(await readFile(join(root, '.env'), 'utf8')).toBe(`API_KEY=${value}\nDEBUG=0\n`)
      // Text that only looks like a placeholder, for a value SideKick does not hold, is ordinary.
      const other = await executeWorkspaceMutation(root, {
        kind: 'write',
        filePath: 'notes.md',
        content: 'Output reads [secret: example] where a value was hidden.\n',
        accessLevel: 'auto'
      })
      expect(other.ok).toBe(true)
    } finally {
      credentialRedactor.setSecrets([])
    }
  })

  it.each(['-old\n+new', 'old\nnew'])(
    'rejects non-canonical patch input without touching the file',
    async (patch) => {
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
    }
  )

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

  describe('model copies that differ only in formatting', () => {
    const replace = (
      root: string,
      filePath: string,
      oldText: string,
      newText: string,
      replaceAll = false
    ) =>
      executeWorkspaceMutation(root, {
        kind: 'replace',
        filePath,
        oldText,
        newText,
        replaceAll,
        accessLevel: 'auto'
      })

    it('matches retyped quotes and dashes and keeps the file typography', async () => {
      const root = await workspace()
      const original =
        '# Report — 2026\n\n| Wildfire | “Not confirmed” — confirm via the NDF map. |  \n| HOA | ❓ |\n'
      await writeFile(join(root, 'report.md'), original, 'utf8')
      const result = await replace(
        root,
        'report.md',
        '| Wildfire | "Not confirmed" - confirm via the NDF map. |',
        '| Wildfire | "Not confirmed" - confirmed outside the NDF zone. |'
      )
      expect(result).toMatchObject({ ok: true, changed: true })
      expect(await readFile(join(root, 'report.md'), 'utf8')).toBe(
        '# Report — 2026\n\n| Wildfire | “Not confirmed” — confirmed outside the NDF zone. |  \n| HOA | ❓ |\n'
      )
    })

    it('matches a copy that dropped an emoji variation selector and LF for CRLF', async () => {
      const root = await workspace()
      await writeFile(join(root, 'a.md'), 'x\r\n| ⚠️ Expected low |\r\ny\r\n', 'utf8')
      const result = await replace(root, 'a.md', 'x\n| ⚠ Expected low |', 'x\n| ✅ Low |')
      expect(result.ok).toBe(true)
      expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('x\r\n| ✅ Low |\r\ny\r\n')
    })

    it('strips read-tool line numbers only when every line has one', async () => {
      const root = await workspace()
      await writeFile(join(root, 'a.ts'), 'const a = 1\nconst b = 2\n', 'utf8')
      const result = await replace(
        root,
        'a.ts',
        '1: const a = 1\n2: const b = 2',
        '1: const a = 10\n2: const b = 2'
      )
      expect(result.ok).toBe(true)
      expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 10\nconst b = 2\n')
    })

    it('keeps one stray CRLF line in an LF file instead of converting the file', async () => {
      const root = await workspace()
      await writeFile(join(root, 'mixed.md'), 'one\ntwo\nthree\r\n', 'utf8')
      expect((await replace(root, 'mixed.md', 'one\ntwo', 'ONE\ntwo')).ok).toBe(true)
      expect(await readFile(join(root, 'mixed.md'), 'utf8')).toBe('ONE\ntwo\nthree\r\n')
    })

    it('rejects ambiguous tolerant matches and shows the closest text when nothing matches', async () => {
      const root = await workspace()
      await writeFile(join(root, 'q.md'), 'say “hi” now\nsay "hi" now\nother line here\n', 'utf8')
      const ambiguous = await replace(root, 'q.md', "say 'hi' now", 'bye')
      expect(ambiguous.ok).toBe(false)
      const missing = await replace(root, 'q.md', 'other line hear', 'x')
      expect(missing.failure?.code).toBe('text_not_found')
      expect(missing.error).toContain('3: other line here')
      expect(await readFile(join(root, 'q.md'), 'utf8')).toBe(
        'say “hi” now\nsay "hi" now\nother line here\n'
      )
    })

    it('accepts an absolute path inside the project and ./ prefixes', async () => {
      const root = await workspace()
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'src/a.ts'), 'a\n', 'utf8')
      const absolute = await replace(root, join(root, 'src', 'a.ts'), 'a', 'b')
      expect(absolute).toMatchObject({ ok: true })
      expect(absolute.files[0].path).toBe('src/a.ts')
      expect((await replace(root, './src/a.ts', 'b', 'c')).files[0].path).toBe('src/a.ts')
      const outside = await replace(root, join(tmpdir(), 'elsewhere.txt'), 'x', 'y')
      expect(outside.ok).toBe(false)
      expect(outside.error).toContain('outside the project')
    })

    it('keeps the line endings of a file that write replaces', async () => {
      const root = await workspace()
      await writeFile(join(root, 'w.txt'), 'old\r\nlines\r\n', 'utf8')
      const result = await executeWorkspaceMutation(root, {
        kind: 'write',
        filePath: 'w.txt',
        content: 'new\nlines\n',
        accessLevel: 'auto'
      })
      expect(result.ok).toBe(true)
      expect(await readFile(join(root, 'w.txt'), 'utf8')).toBe('new\r\nlines\r\n')
    })
  })

  describe('file encodings', () => {
    const BOM = String.fromCharCode(0xfeff)
    const REPLACEMENT = String.fromCharCode(0xfffd)
    const patch = (path: string, from: string, to: string) => ({
      kind: 'apply-patch' as const,
      patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n-${from}\n+${to}\n*** End Patch`,
      accessLevel: 'auto' as const
    })

    it('refuses to edit a file that is not text, and rolls back its bytes exactly', async () => {
      const root = await workspace()
      // Latin-1 text: valid bytes, not UTF-8. Decoding it as UTF-8 replaced each é with U+FFFD.
      const latin1 = Buffer.from('caf\xe9 = 1\n', 'latin1')
      await writeFile(join(root, 'legacy.txt'), latin1)
      for (const request of [
        {
          kind: 'replace' as const,
          filePath: 'legacy.txt',
          oldText: '1',
          newText: '2',
          replaceAll: false,
          accessLevel: 'auto' as const
        },
        patch('legacy.txt', `caf${REPLACEMENT} = 1`, `caf${REPLACEMENT} = 2`)
      ]) {
        const result = await executeWorkspaceMutation(root, request)
        expect(result, request.kind).toMatchObject({ ok: false, changed: false })
        expect(result.error).toContain('not UTF-8 or UTF-16 text')
      }
      // A failed patch restores the binary file it deleted byte for byte.
      const failed = await executeWorkspaceMutation(root, {
        kind: 'apply-patch',
        accessLevel: 'auto',
        patch: `*** Begin Patch
*** Delete File: legacy.txt
*** Add File: generated/parent.txt
+parent
*** Add File: generated/parent.txt/child.txt
+child
*** End Patch`
      })
      expect(failed.ok).toBe(false)
      expect(await readFile(join(root, 'legacy.txt'))).toEqual(latin1)
    })

    it('keeps a UTF-8 byte order mark through write and apply_patch', async () => {
      const root = await workspace()
      await writeFile(join(root, 'bom.txt'), `${BOM}first\nsecond\n`, 'utf8')
      expect((await executeWorkspaceMutation(root, patch('bom.txt', 'first', 'one'))).ok).toBe(true)
      expect(await readFile(join(root, 'bom.txt'), 'utf8')).toBe(`${BOM}one\nsecond\n`)
      const written = await executeWorkspaceMutation(root, {
        kind: 'write',
        filePath: 'bom.txt',
        content: 'rewritten\n',
        accessLevel: 'auto'
      })
      expect(written.ok).toBe(true)
      expect(await readFile(join(root, 'bom.txt'), 'utf8')).toBe(`${BOM}rewritten\n`)
    })

    it('edits the lines of a file that ends lines with a lone CR', async () => {
      const root = await workspace()
      await writeFile(join(root, 'mac.txt'), 'one\rtwo\rthree\r', 'utf8')
      expect((await executeWorkspaceMutation(root, patch('mac.txt', 'two', '2'))).ok).toBe(true)
      const edited = await executeWorkspaceMutation(root, {
        kind: 'replace',
        filePath: 'mac.txt',
        oldText: 'one\n2',
        newText: '1\n2',
        replaceAll: false,
        accessLevel: 'auto'
      })
      expect(edited.ok).toBe(true)
      expect(await readFile(join(root, 'mac.txt'), 'utf8')).toBe('1\r2\rthree\r')
    })

    it('reads and edits UTF-16LE text without rewriting it as UTF-8', async () => {
      const root = await workspace()
      const utf16 = (text: string) =>
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
      await writeFile(join(root, 'out.txt'), utf16('alpha\r\nbeta\r\n'))
      const read = await new WorkspaceReadService().readPath(root, 'out.txt')
      expect(read).toMatchObject({ kind: 'file', content: '1: alpha\n2: beta' })
      expect((await executeWorkspaceMutation(root, patch('out.txt', 'beta', 'gamma'))).ok).toBe(
        true
      )
      expect(await readFile(join(root, 'out.txt'))).toEqual(utf16('alpha\r\ngamma\r\n'))
    })
  })

  it('reports a patch hunk that does not match as input to correct, not a stale read', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'actual\n', 'utf8')
    const result = await executeWorkspaceMutation(root, {
      kind: 'apply-patch',
      patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-imagined\n+changed\n*** End Patch',
      accessLevel: 'auto'
    })
    expect(result).toMatchObject({ ok: false, failure: { code: 'text_not_found' } })
  })

  it('gives one file one read receipt under every spelling of its path', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/Name.txt'), 'one\n', 'utf8')
    const { version } = await new WorkspaceReadService().readFile(root, 'src/Name.txt')
    const spelling = process.platform === 'linux' ? 'src/../src/Name.txt' : 'src/../SRC/name.TXT'
    const result = await executeWorkspaceMutation(
      root,
      {
        kind: 'replace',
        filePath: spelling,
        oldText: 'one',
        newText: 'two',
        replaceAll: false,
        accessLevel: 'auto'
      },
      {
        requireReadReceipt: true,
        expectedVersions: { [workspacePathKey('src/Name.txt')]: version }
      }
    )
    expect(result).toMatchObject({ ok: true })
  })

  it.skipIf(process.platform === 'linux')('renames a file to a different letter case', async () => {
    const root = await workspace()
    await writeFile(join(root, 'readme.md'), 'old\n', 'utf8')
    const result = await executeWorkspaceMutation(root, {
      kind: 'apply-patch',
      patch:
        '*** Begin Patch\n*** Update File: readme.md\n*** Move to: README.md\n@@\n-old\n+new\n*** End Patch',
      accessLevel: 'auto'
    })
    expect(result).toMatchObject({ ok: true })
    expect(await readdir(root)).toEqual(['README.md'])
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('new\n')
  })

  it('refuses to write through a file with another hard link', async () => {
    const root = await workspace()
    const elsewhere = await workspace()
    await writeFile(join(elsewhere, 'shared.txt'), 'outside\n', 'utf8')
    await link(join(elsewhere, 'shared.txt'), join(root, 'shared.txt'))
    const result = await executeWorkspaceMutation(root, {
      kind: 'write',
      filePath: 'shared.txt',
      content: 'changed\n',
      accessLevel: 'auto'
    })
    expect(result).toMatchObject({ ok: false, changed: false })
    expect(result.error).toContain('hard link')
    expect(await readFile(join(elsewhere, 'shared.txt'), 'utf8')).toBe('outside\n')
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

    // Deleting copies no text from a read, so it needs none; a read made stale still refuses.
    const remove = {
      kind: 'delete' as const,
      filePath: 'receipt.txt',
      accessLevel: 'auto' as const
    }
    expect(
      await executeWorkspaceMutation(root, remove, {
        requireReadReceipt: true,
        expectedVersions: { 'receipt.txt': receipt.version }
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining('Stale read receipt') })
    expect(
      await executeWorkspaceMutation(root, remove, { requireReadReceipt: true })
    ).toMatchObject({ ok: true, changed: true })
  })

  it('patches files in two project folders together, or neither when a path climbs out', async () => {
    const parent = await workspace()
    const root = join(parent, 'app')
    const api = join(parent, 'api')
    await mkdir(root)
    await mkdir(api)
    await writeFile(join(root, 'a.txt'), 'app\n')
    await writeFile(join(api, 'b.txt'), 'api\n')
    await writeFile(join(parent, 'outside.txt'), 'outside\n')
    setWorkspaceFolderLookup((workspaceRoot) =>
      workspaceRoot === root ? [{ name: 'api', path: api }] : []
    )
    const reads = new WorkspaceReadService()
    const receipts = {
      [workspacePathKey('a.txt')]: (await reads.getFileVersion(root, 'a.txt'))!,
      [workspacePathKey('api/b.txt')]: (await reads.getFileVersion(root, 'api/b.txt'))!
    }
    const patch = (second: string): string =>
      `*** Begin Patch\n*** Update File: a.txt\n@@\n-app\n+app 2\n*** Update File: ${second}\n@@\n-api\n+api 2\n*** End Patch`

    const escaped = await executeWorkspaceMutation(
      root,
      { kind: 'apply-patch', patch: patch('api/../../outside.txt'), accessLevel: 'auto' },
      { requireReadReceipt: true, expectedVersions: receipts }
    )
    expect(escaped.ok).toBe(false)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('app\n')
    expect(await readFile(join(parent, 'outside.txt'), 'utf8')).toBe('outside\n')

    const result = await executeWorkspaceMutation(
      root,
      { kind: 'apply-patch', patch: patch('api/b.txt'), accessLevel: 'auto' },
      { requireReadReceipt: true, expectedVersions: receipts }
    )
    expect(result).toMatchObject({ ok: true })
    expect(result.files.map((file) => file.path)).toEqual(['a.txt', 'api/b.txt'])
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('app 2\n')
    expect(await readFile(join(api, 'b.txt'), 'utf8')).toBe('api 2\n')
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
