import { afterEach, describe, expect, it } from 'vitest'
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, relative, resolve, sep } from 'path'
import {
  OutsideProjectError,
  projectRelativePath,
  resolveSecureWorkspacePath
} from './workspacePaths'

const roots: string[] = []

async function workspace(): Promise<{ parent: string; root: string }> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'sidekick-workspace-paths-')))
  roots.push(parent)
  const root = join(parent, 'project')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'a.ts'), 'inside\n')
  await writeFile(join(parent, 'outside.txt'), 'outside\n')
  return { parent, root }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && resolve(root, rel) === path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('workspace path containment', () => {
  it('still resolves every spelling of a path inside the project', async () => {
    const { root } = await workspace()
    for (const path of ['src/a.ts', './src/a.ts', 'src/../src/a.ts', join(root, 'src', 'a.ts')]) {
      expect(await resolveSecureWorkspacePath(root, path), path).toBe(join(root, 'src', 'a.ts'))
    }
    expect(projectRelativePath(root, join(root, 'src', 'a.ts'))).toBe('src/a.ts')
  })

  it('refuses traversal and absolute paths outside the project as out of scope', async () => {
    const { parent, root } = await workspace()
    const refused = [
      '..',
      '../outside.txt',
      'src/../../outside.txt',
      './src/./../../outside.txt',
      'src/../../project-sibling/x.ts',
      join(parent, 'outside.txt'),
      resolve(root, '..', '..'),
      `${root}-sibling${sep}x.ts`,
      ...(process.platform === 'win32'
        ? [
            'src\\..\\..\\outside.txt',
            'src/..\\../outside.txt',
            '\\\\server\\share\\outside.txt',
            '//server/share/outside.txt',
            '\\\\?\\C:\\Windows\\win.ini',
            `${root.slice(0, 2) === 'C:' ? 'D:' : 'C:'}\\outside.txt`
          ]
        : ['/etc/passwd', '//server/share/outside.txt'])
    ]
    for (const path of refused) {
      await expect(resolveSecureWorkspacePath(root, path), path).rejects.toBeInstanceOf(
        OutsideProjectError
      )
    }
    expect(() => projectRelativePath(root, join(parent, 'outside.txt'))).toThrow(
      OutsideProjectError
    )
  })

  it.skipIf(process.platform === 'win32')(
    'keeps backslashes, which name characters on POSIX, inside the project',
    async () => {
      const { root } = await workspace()
      for (const path of ['src\\..\\..\\outside.txt', '\\\\server\\share\\outside.txt']) {
        expect(inside(root, await resolveSecureWorkspacePath(root, path)), path).toBe(true)
      }
    }
  )

  it('refuses a link inside the project that leads outside it', async () => {
    const { parent, root } = await workspace()
    await mkdir(join(parent, 'elsewhere'))
    await writeFile(join(parent, 'elsewhere', 'secret.txt'), 'outside\n')
    // A junction needs no privilege on Windows; elsewhere it is an ordinary directory link.
    await symlink(join(parent, 'elsewhere'), join(root, 'link'), 'junction')
    await expect(resolveSecureWorkspacePath(root, 'link/secret.txt')).rejects.toBeInstanceOf(
      OutsideProjectError
    )
  })

  it('refuses a file with another hard link only where the target is written', async () => {
    const { parent, root } = await workspace()
    await link(join(parent, 'outside.txt'), join(root, 'linked.txt'))
    await expect(
      resolveSecureWorkspacePath(root, 'linked.txt', { rejectLinks: true })
    ).rejects.toThrow('hard link')
    expect(await resolveSecureWorkspacePath(root, 'linked.txt')).toBe(join(root, 'linked.txt'))
    expect(await resolveSecureWorkspacePath(root, 'src/a.ts', { rejectLinks: true })).toBe(
      join(root, 'src', 'a.ts')
    )
  })

  it('keeps other refusals apart from the project boundary', async () => {
    const { root } = await workspace()
    const nul = await resolveSecureWorkspacePath(root, 'src/a\0.ts').catch((error) => error)
    expect(nul).toBeInstanceOf(Error)
    expect(nul).not.toBeInstanceOf(OutsideProjectError)
  })
})
