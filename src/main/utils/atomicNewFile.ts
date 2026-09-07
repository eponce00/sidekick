import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'

/**
 * Publish complete bytes without overwriting any destination entry. The hard link
 * is the commit point: cancellation is checked immediately before it; afterwards
 * the final file is never removed, even if stage cleanup fails. Filesystems that
 * cannot hard-link fail closed (no non-atomic copy/rename fallback).
 * A process crash can leave an unreferenced stage, but not a partial final file.
 */
export async function atomicNewFile(
  destination: string,
  write: (handle: FileHandle) => Promise<void>,
  signal?: AbortSignal,
  validateDirectory?: () => Promise<void>
): Promise<void> {
  signal?.throwIfAborted()
  const stage = join(dirname(destination), `.sidekick-download-${randomUUID()}.partial`)
  let handle: FileHandle | undefined
  let ownsStage = false
  try {
    await validateDirectory?.()
    signal?.throwIfAborted()
    handle = await fs.open(stage, 'wx', 0o600)
    ownsStage = true
    signal?.throwIfAborted()
    await write(handle)
    signal?.throwIfAborted()
    await handle.sync()
    await handle.close()
    handle = undefined
    signal?.throwIfAborted()
    await validateDirectory?.()
    signal?.throwIfAborted()
    await fs.link(stage, destination)
  } finally {
    await handle?.close().catch(() => undefined)
    // Never clean up the final path: it may belong to a competing writer.
    if (ownsStage) {
      // A rebound directory makes the stage pathname untrustworthy too. Retain
      // an orphan rather than deleting an entry in a changed namespace.
      let safe = true
      try {
        await validateDirectory?.()
      } catch {
        safe = false
      }
      if (safe) await fs.unlink(stage).catch(() => undefined)
    }
  }
}
