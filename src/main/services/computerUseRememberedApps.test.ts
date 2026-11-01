import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { ComputerUseRememberedApps } from './computerUseRememberedApps'

describe('always allowed apps', () => {
  const folder = mkdtempSync(join(tmpdir(), 'sidekick-remembered-'))
  const app = join(folder, 'notes.exe')
  const store = new ComputerUseRememberedApps(() => join(folder, 'apps.json'))
  afterEach(() => rmSync(join(folder, 'apps.json'), { force: true }))

  it('asks again when the executable has changed, so a swapped file inherits nothing', async () => {
    writeFileSync(app, 'first')
    await store.add(app)
    expect(await store.has(app)).toBe(true)
    writeFileSync(app, 'swapped')
    expect(await store.has(app)).toBe(false)
  })

  it('forgets an app the user removes, and survives a damaged file', async () => {
    writeFileSync(app, 'first')
    await store.add(app)
    expect(await store.list()).toEqual([{ path: app, name: 'notes' }])
    await store.remove(app)
    expect(await store.has(app)).toBe(false)
    writeFileSync(join(folder, 'apps.json'), 'not json')
    expect(await store.has(app)).toBe(false)
  })
})
