import { promises as fs } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'

const failure =
  'Publication directory changed or is unavailable; reopen the document or retry the download'
interface Identity {
  path: string
  real: string
  dev: bigint
  ino: bigint
}
export interface PublicationDirectory {
  prepare(signal?: AbortSignal): Promise<void>
  assertUnchanged(signal?: AbortSignal): Promise<void>
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b)
}
async function identity(path: string): Promise<Identity> {
  const real = await fs.realpath(path)
  const stat = await fs.stat(path, { bigint: true })
  if (!stat.isDirectory() || stat.ino === 0n || !samePath(real, await fs.realpath(path)))
    throw new Error(failure)
  return { path, real, dev: stat.dev, ino: stat.ino }
}
async function unchanged(saved: Identity): Promise<void> {
  const now = await identity(saved.path)
  if (!samePath(saved.real, now.real) || saved.dev !== now.dev || saved.ino !== now.ino)
    throw new Error(failure)
}
async function anchor(path: string): Promise<Identity> {
  let current = path
  while (true) {
    try {
      return await identity(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}
async function assertAbsentSuffix(saved: Identity, target: string): Promise<void> {
  if (samePath(saved.path, target)) return
  // Any newly appeared first component invalidates the original missing suffix.
  const first = relative(saved.path, target).split(sep)[0]
  try {
    await fs.lstat(resolve(saved.path, first))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error(failure)
}

/**
 * Detect ordinary directory replacement across long asynchronous work. This is
 * NOT race-free: Node's path-based mkdir/open/link still have a check/use window.
 * No filesystem mutation occurs during capture, including missing Downloads.
 */
export async function capturePublicationDirectory(
  authorizedRoot: string,
  destinationDirectory: string,
  allowCreate = false
): Promise<PublicationDirectory> {
  try {
    const root = resolve(authorizedRoot),
      directory = resolve(destinationDirectory)
    if (!inside(root, directory)) throw new Error(failure)
    const rootAnchor = await anchor(root)
    const parentAnchor = await anchor(directory)
    const realRoot = resolve(rootAnchor.real, relative(rootAnchor.path, root))
    const realDirectory = resolve(parentAnchor.real, relative(parentAnchor.path, directory))
    if (!inside(realRoot, realDirectory)) throw new Error(failure)
    if (
      !allowCreate &&
      (!samePath(rootAnchor.path, root) || !samePath(parentAnchor.path, directory))
    )
      throw new Error(failure)
    await unchanged(rootAnchor)
    await unchanged(parentAnchor)
    await assertAbsentSuffix(rootAnchor, root)
    await assertAbsentSuffix(parentAnchor, directory)
    let prepared: Promise<void> | undefined
    let boundRoot: Identity | undefined, boundParent: Identity | undefined
    const checkAnchors = async (signal?: AbortSignal): Promise<void> => {
      signal?.throwIfAborted()
      await unchanged(rootAnchor)
      await unchanged(parentAnchor)
      signal?.throwIfAborted()
    }
    const check = async (signal?: AbortSignal): Promise<void> => {
      try {
        await checkAnchors(signal)
        if (!boundRoot || !boundParent) throw new Error(failure)
        await unchanged(boundRoot)
        await unchanged(boundParent)
        signal?.throwIfAborted()
      } catch {
        signal?.throwIfAborted()
        throw new Error(failure)
      }
    }
    return {
      prepare(signal) {
        if (!prepared) {
          let creationStarted = false
          prepared = (async () => {
            try {
              await checkAnchors(signal)
              await assertAbsentSuffix(rootAnchor, root)
              await assertAbsentSuffix(parentAnchor, directory)
              signal?.throwIfAborted()
              if (!samePath(parentAnchor.path, directory)) {
                creationStarted = true
                await fs.mkdir(directory, { recursive: true })
              }
              // Once our mkdir completed, bind its identity even if this request
              // was cancelled. Later requests must not mistake our own creation
              // for an unrelated directory that appeared after capture.
              boundRoot = await identity(root)
              boundParent = await identity(directory)
              if (!samePath(boundRoot.real, realRoot) || !samePath(boundParent.real, realDirectory))
                throw new Error(failure)
              await check()
            } catch {
              signal?.throwIfAborted()
              throw new Error(failure)
            }
          })()
          const current = prepared
          void current.catch(() => {
            if (signal?.aborted && !creationStarted && prepared === current) prepared = undefined
          })
        }
        return prepared.then(() => signal?.throwIfAborted())
      },
      assertUnchanged: check
    }
  } catch {
    throw new Error(failure)
  }
}
