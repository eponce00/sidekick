import { promises as fs } from 'fs'
import { join } from 'path'

/** Past this many, a folder's count says "more than", so a huge folder still answers quickly. */
export const PATH_ITEM_COUNT_LIMIT = 10_000

/**
 * How many files and folders a folder holds, at any depth, counting up to `limit`. Links are
 * counted but not followed.
 */
export async function countPathItems(
  folder: string,
  limit = PATH_ITEM_COUNT_LIMIT
): Promise<{ count: number; more: boolean }> {
  let count = 0
  const pending = [folder]
  while (pending.length) {
    const current = pending.pop()!
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (count >= limit) return { count, more: true }
      count++
      if (entry.isDirectory()) pending.push(join(current, entry.name))
    }
  }
  return { count, more: false }
}
