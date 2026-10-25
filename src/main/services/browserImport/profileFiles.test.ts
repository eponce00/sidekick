import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readProfileFile, readSqliteSnapshot } from './profileFiles'

describe('profile files', () => {
  let directory: string
  let temp: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sidekick-profile-files-test-'))
    temp = join(directory, 'temp')
    mkdirSync(temp)
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('reads a database the browser still has open, including writes only in its WAL', async () => {
    const path = join(directory, 'places.sqlite')
    const browser = new Database(path)
    browser.pragma('journal_mode = WAL')
    browser.pragma('wal_autocheckpoint = 0')
    browser.exec('CREATE TABLE pages (url TEXT)')
    browser.prepare('INSERT INTO pages VALUES (?)').run('https://in-wal.example/')
    try {
      const urls = await readSqliteSnapshot(
        path,
        (db) =>
          (db.prepare('SELECT url FROM pages').all() as Array<{ url: string }>).map(
            (row) => row.url
          ),
        temp
      )
      expect(urls).toEqual(['https://in-wal.example/'])
      // The browser's own connection keeps working.
      browser.prepare('INSERT INTO pages VALUES (?)').run('https://after.example/')
    } finally {
      browser.close()
    }
    expect(readdirSync(temp)).toEqual([])
  })

  it('cannot write to the copy, and deletes it even when reading fails', async () => {
    const path = join(directory, 'History')
    const db = new Database(path)
    db.exec('CREATE TABLE urls (url TEXT)')
    db.close()
    await expect(
      readSqliteSnapshot(path, (copy) => copy.exec("INSERT INTO urls VALUES ('x')"), temp)
    ).rejects.toThrow()
    expect(readdirSync(temp)).toEqual([])
  })

  it('returns undefined for a missing file', async () => {
    expect(await readSqliteSnapshot(join(directory, 'nope'), () => 1, temp)).toBeUndefined()
    expect(await readProfileFile(join(directory, 'nope'), 10)).toBeUndefined()
  })

  it('refuses a folder in place of a file, and a file over the size limit', async () => {
    mkdirSync(join(directory, 'Bookmarks'))
    await expect(readProfileFile(join(directory, 'Bookmarks'), 100)).rejects.toMatchObject({
      failure: 'unreadable'
    })
    writeFileSync(join(directory, 'big'), 'x'.repeat(101))
    await expect(readProfileFile(join(directory, 'big'), 100)).rejects.toMatchObject({
      failure: 'too_large'
    })
  })

  it('refuses a link instead of following it to another file', async (context) => {
    writeFileSync(join(directory, 'secret.txt'), 'elsewhere')
    try {
      symlinkSync(join(directory, 'secret.txt'), join(directory, 'Bookmarks'), 'file')
    } catch {
      // Windows needs Developer Mode or elevation to create links.
      context.skip()
    }
    await expect(readProfileFile(join(directory, 'Bookmarks'), 100)).rejects.toMatchObject({
      failure: 'unreadable'
    })
  })
})
