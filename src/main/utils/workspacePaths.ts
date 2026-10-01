import { promises as fs } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'

export interface SecureWorkspacePathOptions {
  rejectSymlinks?: boolean
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes the project root: ${target}`)
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
 * or prefix ./, so an absolute path inside the project and ./ prefixes name the same file as the
 * plain relative path; read receipts and change records are keyed by this spelling.
 */
export function projectRelativePath(workspaceRoot: string, requestedPath: string): string {
  let path = requestedPath.trim()
  if (isAbsolute(path)) {
    const rel = relative(resolve(workspaceRoot), resolve(path))
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(
        `Path is outside the project: ${requestedPath}. Use a path relative to the project root.`
      )
    }
    path = rel
  }
  return path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')
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

  if (options.rejectSymlinks) {
    let segment = lexicalRoot
    for (const part of relative(lexicalRoot, candidate).split(sep).filter(Boolean)) {
      segment = resolve(segment, part)
      try {
        if ((await fs.lstat(segment)).isSymbolicLink()) {
          throw new Error(`Symbolic-link mutation paths are not supported: ${requestedPath}`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
    }
  }

  return candidate
}
