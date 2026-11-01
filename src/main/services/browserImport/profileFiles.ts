import Database from 'better-sqlite3'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

/** Why a profile file could not be read; the service turns it into words for the user. */
export type ProfileFileFailure = 'permission' | 'locked' | 'unreadable' | 'too_large'

export class ProfileFileError extends Error {
  constructor(
    readonly failure: ProfileFileFailure,
    message: string
  ) {
    super(message)
  }
}

const MAX_DATABASE_BYTES = 2 * 1024 * 1024 * 1024

function failureOf(error: unknown): ProfileFileFailure {
  const code = (error as { code?: unknown })?.code
  if (code === 'EPERM' || code === 'EACCES') return 'permission'
  if (code === 'EBUSY' || code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return 'locked'
  return 'unreadable'
}

/**
 * Stats a file the import may read: undefined when it does not exist, an error when it is not a
 * plain file. A link is refused rather than followed, so a profile cannot point the import at a
 * file somewhere else.
 */
async function regularFile(path: string, maxBytes: number): Promise<number | undefined> {
  let stat
  try {
    stat = await fs.lstat(path)
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'ENOENT') return undefined
    throw new ProfileFileError(failureOf(error), `Cannot read ${basename(path)}`)
  }
  if (!stat.isFile()) throw new ProfileFileError('unreadable', `${basename(path)} is not a file`)
  if (stat.size > maxBytes)
    throw new ProfileFileError('too_large', `${basename(path)} is too large`)
  return stat.size
}

/** The file's bytes, or undefined when it does not exist. */
export async function readProfileFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  if ((await regularFile(path, maxBytes)) === undefined) return undefined
  try {
    const bytes = await fs.readFile(path)
    if (bytes.length > maxBytes)
      throw new ProfileFileError('too_large', `${basename(path)} is too large`)
    return bytes
  } catch (error) {
    if (error instanceof ProfileFileError) throw error
    throw new ProfileFileError(failureOf(error), `Cannot read ${basename(path)}`)
  }
}

/** Throws unless each named table exists as a real table, not a view that would run its own query. */
export function requireTables(db: Database.Database, tables: string[]): void {
  const found = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: unknown
      }>
    ).map((row) => row.name)
  )
  const missing = tables.filter((table) => !found.has(table))
  if (missing.length) throw new ProfileFileError('unreadable', `Missing table ${missing[0]}`)
}

/**
 * Runs `read` on a private copy of another browser's SQLite database, or returns undefined when
 * the database does not exist. A browser keeps its database open, and may lock it; the copy is
 * never shared with it, so the browser is not disturbed, and is deleted afterwards. SQLite brings
 * the copy to the last complete state from its journal, as the browser would after a crash.
 */
export async function readSqliteSnapshot<T>(
  path: string,
  read: (db: Database.Database) => T,
  tempRoot: string = tmpdir()
): Promise<T | undefined> {
  if ((await regularFile(path, MAX_DATABASE_BYTES)) === undefined) return undefined
  const directory = await fs.mkdtemp(join(tempRoot, 'sidekick-import-'))
  try {
    const copy = join(directory, 'snapshot.sqlite')
    try {
      await fs.copyFile(path, copy)
      for (const suffix of ['-wal', '-journal']) {
        if ((await regularFile(`${path}${suffix}`, MAX_DATABASE_BYTES)) !== undefined) {
          await fs.copyFile(`${path}${suffix}`, `${copy}${suffix}`)
        }
      }
    } catch (error) {
      if (error instanceof ProfileFileError) throw error
      throw new ProfileFileError(failureOf(error), `Cannot copy ${basename(path)}`)
    }
    let db: Database.Database | undefined
    try {
      db = new Database(copy, { fileMustExist: true })
      // A crafted database could otherwise run functions from its schema while it is read.
      db.pragma('trusted_schema = OFF')
      db.pragma('query_only = ON')
      return read(db)
    } catch (error) {
      if (error instanceof ProfileFileError) throw error
      throw new ProfileFileError(failureOf(error), `Cannot read ${basename(path)}`)
    } finally {
      db?.close()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}
