import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { applicationArtifact } from './applicationArtifact'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    expect(dirname(await fs.realpath(root))).toBe(await fs.realpath(tmpdir()))
    expect(root).toContain('sidekick-artifact-')
    await fs.rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'sidekick-artifact-'))
  roots.push(root)
  await fs.mkdir(join(root, 'out', 'main'), { recursive: true })
  return { root, file: join(root, 'out', 'main', 'index.js') }
}
it('distinguishes same-version bundles and exports no source or paths', async () => {
  const { root, file } = await fixture()
  const source = 'synthetic application source'
  await fs.writeFile(file, source)
  const first = await applicationArtifact(root)
  expect(first).toEqual({
    scope: 'main-bundle-on-disk',
    algorithm: 'sha256',
    sha256: createHash('sha256').update(source).digest('hex')
  })
  expect(JSON.stringify(first)).not.toContain(root)
  expect(JSON.stringify(first)).not.toContain(source)
  await fs.writeFile(file, 'different build')
  expect((await applicationArtifact(root)).sha256).not.toBe(first.sha256)
})
it('reports unavailable for missing, empty or oversized files without error details', async () => {
  const { root, file } = await fixture()
  expect((await applicationArtifact(root)).sha256).toBeNull()
  await fs.writeFile(file, '')
  expect((await applicationArtifact(root)).sha256).toBeNull()
  await fs.truncate(file, 16 * 1024 * 1024 + 1)
  expect((await applicationArtifact(root)).sha256).toBeNull()
})
it('rejects a changing file and closes the handle even when reads fail', async () => {
  const { root, file } = await fixture()
  await fs.writeFile(file, 'synthetic')
  const actualOpen = fs.open.bind(fs)
  let closed = 0
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await actualOpen(...args)
    const stat = handle.stat.bind(handle),
      close = handle.close.bind(handle)
    let calls = 0
    vi.spyOn(handle, 'stat').mockImplementation(async () => {
      const value = await stat()
      if (++calls > 1) value.mtimeMs += 1
      return value
    })
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      closed++
      await close()
    })
    return handle
  })
  expect((await applicationArtifact(root)).sha256).toBeNull()
  expect(closed).toBe(1)
  vi.restoreAllMocks()
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await actualOpen(...args),
      close = handle.close.bind(handle)
    vi.spyOn(handle, 'read').mockRejectedValue(new Error('private path must not escape'))
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      closed++
      await close()
    })
    return handle
  })
  expect((await applicationArtifact(root)).sha256).toBeNull()
  expect(closed).toBe(2)
})
