import { afterEach, describe, expect, it } from 'vitest'
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, relative, resolve, sep } from 'path'
import {
  OutsideProjectError,
  projectRelativePath,
  resolveSecureWorkspacePath,
  setWorkspaceFolderLookup
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
  setWorkspaceFolderLookup(() => [])
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A project of two folders side by side, `project` and `api`, and a folder it never added. */
async function twoFolders(): Promise<{ parent: string; root: string; api: string }> {
  const { parent, root } = await workspace()
  const api = join(parent, 'api')
  await mkdir(join(api, 'src'), { recursive: true })
  await writeFile(join(api, 'src', 'b.ts'), 'api\n')
  await mkdir(join(parent, 'never-added'))
  await writeFile(join(parent, 'never-added', 'secret.txt'), 'secret\n')
  setWorkspaceFolderLookup((workspaceRoot) =>
    workspaceRoot === resolve(root) ? [{ name: 'api', path: api }] : []
  )
  return { parent, root, api }
}

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

  it('reaches another project folder by its name or an absolute path, and spells it by name', async () => {
    const { root, api } = await twoFolders()
    const file = join(api, 'src', 'b.ts')
    for (const path of ['api/src/b.ts', 'src/../api/src/b.ts', 'api/./src/b.ts', file]) {
      expect(await resolveSecureWorkspacePath(root, path), path).toBe(file)
      expect(projectRelativePath(root, path), path).toBe('api/src/b.ts')
    }
    // Relative paths without a folder name stay in the primary folder.
    expect(await resolveSecureWorkspacePath(root, 'src/a.ts')).toBe(join(root, 'src', 'a.ts'))
    expect(await resolveSecureWorkspacePath(root, 'api')).toBe(api)
  })

  it('refuses every spelling that climbs out of a project folder, or into a folder never added', async () => {
    const { parent, root } = await twoFolders()
    const refused = [
      'api/../../outside.txt',
      'api/../../never-added/secret.txt',
      'api/src/../../../outside.txt',
      '../never-added/secret.txt',
      '../api/../never-added/secret.txt',
      join(parent, 'never-added', 'secret.txt'),
      join(parent, 'api-sibling', 'x.ts'),
      ...(process.platform === 'win32'
        ? ['api\\..\\..\\outside.txt', 'api/..\\../never-added/secret.txt']
        : [])
    ]
    for (const path of refused) {
      await expect(resolveSecureWorkspacePath(root, path), path).rejects.toBeInstanceOf(
        OutsideProjectError
      )
    }
    // Climbing out of the extra folder by name lands back in the primary, never beside it.
    expect(await resolveSecureWorkspacePath(root, 'api/../src/a.ts')).toBe(
      join(root, 'src', 'a.ts')
    )
  })

  it('refuses a link in one project folder that leads into another, or out of the project', async () => {
    const { parent, root, api } = await twoFolders()
    // A junction needs no privilege on Windows; elsewhere it is an ordinary directory link.
    await symlink(join(root, 'src'), join(api, 'to-primary'), 'junction')
    await symlink(join(parent, 'never-added'), join(api, 'to-never-added'), 'junction')
    await symlink(join(api, 'src'), join(root, 'to-api'), 'junction')
    for (const path of ['api/to-primary/a.ts', 'api/to-never-added/secret.txt', 'to-api/b.ts']) {
      await expect(resolveSecureWorkspacePath(root, path), path).rejects.toBeInstanceOf(
        OutsideProjectError
      )
    }
  })

  it('keeps the primary folder of an extra folder’s name reachable as ./name', async () => {
    const { root, api } = await twoFolders()
    await mkdir(join(root, 'api'))
    await writeFile(join(root, 'api', 'own.ts'), 'primary\n')
    expect(await resolveSecureWorkspacePath(root, 'api/src/b.ts')).toBe(join(api, 'src', 'b.ts'))
    expect(await resolveSecureWorkspacePath(root, './api/own.ts')).toBe(join(root, 'api', 'own.ts'))
    expect(projectRelativePath(root, join(root, 'api', 'own.ts'))).toBe('./api/own.ts')
  })

  it.runIf(process.platform !== 'linux')(
    'matches a folder name and an absolute path whatever their letter case, where names ignore it',
    async () => {
      const { root, api } = await twoFolders()
      const file = join(api, 'src', 'b.ts')
      expect(await resolveSecureWorkspacePath(root, 'API/src/b.ts')).toBe(file)
      expect(projectRelativePath(root, 'Api/src/b.ts')).toBe('api/src/b.ts')
      expect(projectRelativePath(root, file.toUpperCase())).toBe('api/SRC/B.TS')
    }
  )

  it.runIf(process.platform === 'win32')(
    'handles Windows spellings across folders: backslashes, drive letter case and long paths',
    async () => {
      const { root, api } = await twoFolders()
      const file = join(api, 'src', 'b.ts')
      const otherDriveCase = file[0] === file[0].toUpperCase() ? file[0].toLowerCase() : file[0]
      for (const path of [
        'api\\src\\b.ts',
        'api/src\\b.ts',
        `${otherDriveCase}${file.slice(1)}`,
        file.replaceAll('\\', '/')
      ]) {
        expect(await resolveSecureWorkspacePath(root, path), path).toBe(file)
        expect(projectRelativePath(root, path), path).toBe('api/src/b.ts')
      }
      // A path on another drive is in no folder of the project.
      const otherDrive = `${root[0] === 'C' ? 'D' : 'C'}${root.slice(1)}`
      await expect(resolveSecureWorkspacePath(root, otherDrive)).rejects.toBeInstanceOf(
        OutsideProjectError
      )
    }
  )

  it('keeps other refusals apart from the project boundary', async () => {
    const { root } = await workspace()
    const nul = await resolveSecureWorkspacePath(root, 'src/a\0.ts').catch((error) => error)
    expect(nul).toBeInstanceOf(Error)
    expect(nul).not.toBeInstanceOf(OutsideProjectError)
  })
})
