import { promises as fs } from 'fs'
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'path'
import type { WorkspaceFolder } from '../../shared/projects'

export interface SecureWorkspacePathOptions {
  /**
   * Refuse a symbolic link anywhere on the path and a target file with more than one hard link,
   * for callers that write or hand on the target: either kind of link can name a file outside
   * the project.
   */
  rejectLinks?: boolean
}

/**
 * A path outside the project folder, refused before anything reads or writes it. Agent tools
 * report it as `workspace_scope`, an expected refusal rather than a fault.
 */
export class OutsideProjectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutsideProjectError'
  }
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new OutsideProjectError(`Path escapes the project root: ${target}`)
  }
}

async function nearestExistingPath(path: string): Promise<string> {
  let candidate = path
  while (true) {
    try {
      await fs.lstat(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(candidate)
      if (parent === candidate) throw new Error(`Could not resolve an existing parent for ${path}`)
      candidate = parent
    }
  }
}

type WorkspaceFolderLookup = (workspaceRoot: string) => readonly WorkspaceFolder[]

let folderLookup: WorkspaceFolderLookup = () => []

/**
 * Tells path resolution which extra folders belong with a workspace root. The main process reads
 * them from its own project data, so a renderer or a model can name a project folder but never
 * add one.
 */
export function setWorkspaceFolderLookup(lookup: WorkspaceFolderLookup): void {
  folderLookup = lookup
}

/** The extra folders of the project whose primary (or worktree) folder is this root. */
export function workspaceFolders(workspaceRoot: string): readonly WorkspaceFolder[] {
  return folderLookup(resolve(workspaceRoot))
}

/** Every folder of the project whose primary folder is this root, the primary first. */
export function workspaceFolderRoots(workspaceRoot: string): string[] {
  return [
    resolve(workspaceRoot),
    ...workspaceFolders(workspaceRoot).map(({ path }) => resolve(path))
  ]
}

function pathInside(root: string, target: string): string | null {
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel
}

function sameName(left: string, right: string): boolean {
  return workspacePathKey(left) === workspacePathKey(right)
}

/** A path inside one folder of a project: that folder and the path from its root. */
export interface LocatedWorkspacePath {
  /** The folder's root, resolved. */
  root: string
  /** The extra folder's name; null for the primary folder. */
  folder: string | null
  /** The path from the folder's root, with forward slashes; empty for the root itself. */
  path: string
}

/**
 * Finds which project folder a path names. Relative paths mean the primary folder unless their
 * first segment is an extra folder's name; `./name/...` keeps the primary's own `name` folder
 * reachable. An absolute path belongs to the folder it is inside. `..` segments are applied before
 * the folder is chosen, so `api/../x` is the primary's `x`, and no spelling climbs from one folder
 * into another.
 */
export function locateWorkspacePath(
  workspaceRoot: string,
  requestedPath: string
): LocatedWorkspacePath {
  const primary = resolve(workspaceRoot)
  const folders = workspaceFolders(primary)
  let path = requestedPath.trim()
  if (isAbsolute(path)) {
    const target = resolve(path)
    // The closest folder wins, should one sit inside another.
    const owner = [
      { root: primary, folder: null as string | null },
      ...folders.map((folder) => ({ root: resolve(folder.path), folder: folder.name }))
    ]
      .map((candidate) => ({ ...candidate, rel: pathInside(candidate.root, target) }))
      .filter(
        (candidate): candidate is typeof candidate & { rel: string } => candidate.rel !== null
      )
      .sort((a, b) => a.rel.length - b.rel.length)[0]
    if (!owner) throw new OutsideProjectError(`Path is outside the project: ${requestedPath}`)
    return { root: owner.root, folder: owner.folder, path: owner.rel.split(sep).join('/') }
  }
  // Backslashes separate paths only where the platform says so; on POSIX they name characters.
  if (sep === '\\') path = path.replaceAll('\\', '/')
  const explicitPrimary = /^\.\/+/.test(path)
  path = path
    ? posix
        .normalize(path)
        .replace(/^(?:\.\/)+/, '')
        .replace(/^\.$/, '')
    : path
  if (!explicitPrimary && folders.length) {
    const [first, ...rest] = path.split('/')
    const folder = folders.find((candidate) => sameName(candidate.name, first))
    if (folder) return { root: resolve(folder.path), folder: folder.name, path: rest.join('/') }
  }
  return { root: primary, folder: null, path }
}

/**
 * The project-wide spelling of a located path: `name/path` in an extra folder, the plain path in
 * the primary one, and `./path` for a primary path that would otherwise read as an extra folder.
 */
export function qualifiedWorkspacePath(
  workspaceRoot: string,
  located: Pick<LocatedWorkspacePath, 'folder' | 'path'>
): string {
  return workspacePathSpeller(workspaceRoot, located.folder)(located.path)
}

/**
 * Spells many paths of one folder the project-wide way, for listings: the folder's names are read
 * once rather than for every path.
 */
export function workspacePathSpeller(
  workspaceRoot: string,
  folder: string | null
): (pathInFolder: string) => string {
  if (folder) return (path) => (path ? `${folder}/${path}` : folder)
  const names = new Set(workspaceFolders(workspaceRoot).map(({ name }) => workspacePathKey(name)))
  return (path) =>
    names.size && path && names.has(workspacePathKey(path.split('/')[0])) ? `./${path}` : path
}

/**
 * The project-relative spelling of a path. Models often copy the workspace root from the prompt
 * or prefix ./, so an absolute path inside the project, ./ prefixes and `..` segments name the
 * same file as the plain relative path; read receipts and change records are keyed by this
 * spelling. A path in an extra project folder starts with that folder's name.
 */
export function projectRelativePath(workspaceRoot: string, requestedPath: string): string {
  return qualifiedWorkspacePath(workspaceRoot, locateWorkspacePath(workspaceRoot, requestedPath))
}

/**
 * The project spelling of a real (link-free) path, such as one the user chose in a file dialog:
 * each folder is compared by its own real path. Null when no folder holds it.
 */
export async function projectPathForRealPath(
  workspaceRoot: string,
  realPath: string
): Promise<string | null> {
  const primary = resolve(workspaceRoot)
  const candidates = [
    { root: primary, folder: null as string | null },
    ...workspaceFolders(primary).map(({ name, path }) => ({ root: resolve(path), folder: name }))
  ]
  for (const candidate of candidates) {
    const realRoot = await fs.realpath(candidate.root).catch(() => null)
    const rel = realRoot ? pathInside(realRoot, realPath) : null
    if (rel === null) continue
    return qualifiedWorkspacePath(primary, {
      folder: candidate.folder,
      path: rel.split(sep).join('/')
    })
  }
  return null
}

/**
 * Where a project path is on disk, by its spelling alone. Anything that reads or writes the path
 * goes through resolveSecureWorkspacePath, which also follows links.
 */
export function workspaceAbsolutePath(workspaceRoot: string, requestedPath: string): string {
  const located = locateWorkspacePath(workspaceRoot, requestedPath)
  return resolve(located.root, located.path)
}

/**
 * The identity of a project path for lookups: case-insensitive where file systems usually are
 * (Windows and macOS), so two spellings of one file share a read receipt.
 */
export function workspacePathKey(path: string): string {
  return process.platform === 'linux' ? path : path.toLowerCase()
}

/**
 * Resolve a model- or renderer-supplied project-relative path without allowing
 * lexical traversal or a symlink to cross the canonical boundary of the project folder it names.
 */
export async function resolveSecureWorkspacePath(
  workspaceRoot: string,
  requestedPath = '',
  options: SecureWorkspacePathOptions = {}
): Promise<string> {
  if (requestedPath.includes('\0')) throw new Error('Path contains a null byte')
  if (requestedPath.length > 4_096) throw new Error('Path exceeds the 4,096 character safety limit')
  // Each folder is its own boundary: a link inside one may not lead into another.
  const located = locateWorkspacePath(workspaceRoot, requestedPath)
  requestedPath = located.path

  const lexicalRoot = located.root
  const candidate = resolve(lexicalRoot, requestedPath)
  assertInside(lexicalRoot, candidate)

  const [realRoot, existing] = await Promise.all([
    fs.realpath(lexicalRoot),
    nearestExistingPath(candidate)
  ])
  const realExisting = await fs.realpath(existing)
  assertInside(realRoot, realExisting)

  if (options.rejectLinks) {
    let segment = lexicalRoot
    for (const part of relative(lexicalRoot, candidate).split(sep).filter(Boolean)) {
      segment = resolve(segment, part)
      try {
        const stat = await fs.lstat(segment)
        if (stat.isSymbolicLink()) {
          throw new Error(`Symbolic-link mutation paths are not supported: ${requestedPath}`)
        }
        // Another name for the same file may be anywhere on the volume.
        if (segment === candidate && stat.isFile() && stat.nlink > 1) {
          throw new Error(`Files with more than one hard link are not supported: ${requestedPath}`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
    }
  }

  return candidate
}
