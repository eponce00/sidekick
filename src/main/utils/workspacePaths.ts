import { promises as fs } from 'fs'
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'path'

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

/**
 * The project-relative spelling of a path. Models often copy the workspace root from the prompt
 * or prefix ./, so an absolute path inside the project, ./ prefixes and `..` segments name the
 * same file as the plain relative path; read receipts and change records are keyed by this
 * spelling.
 */
export function projectRelativePath(workspaceRoot: string, requestedPath: string): string {
  let path = requestedPath.trim()
  if (isAbsolute(path)) {
    const rel = relative(resolve(workspaceRoot), resolve(path))
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new OutsideProjectError(`Path is outside the project: ${requestedPath}`)
    }
    path = rel
  }
  path = path.replaceAll('\\', '/')
  return path
    ? posix
        .normalize(path)
        .replace(/^(?:\.\/)+/, '')
        .replace(/^\.$/, '')
    : path
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
 * lexical traversal or a symlink to cross the canonical project boundary.
 */
export async function resolveSecureWorkspacePath(
  workspaceRoot: string,
  requestedPath = '',
  options: SecureWorkspacePathOptions = {}
): Promise<string> {
  if (requestedPath.includes('\0')) throw new Error('Path contains a null byte')
  if (requestedPath.length > 4_096) throw new Error('Path exceeds the 4,096 character safety limit')
  if (isAbsolute(requestedPath)) requestedPath = projectRelativePath(workspaceRoot, requestedPath)

  const lexicalRoot = resolve(workspaceRoot)
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
