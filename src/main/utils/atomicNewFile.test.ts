import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { atomicNewFile } from './atomicNewFile'

const roots: string[] = []
async function fixture(): Promise<{ root: string; destination: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'sidekick-atomic-new-'))
  roots.push(root)
  return { root, destination: join(root, 'download.bin') }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('atomic new-file publication', () => {
  it('keeps the destination absent throughout a partial write and publishes complete bytes', async () => {
    const { root, destination } = await fixture()
    await atomicNewFile(destination, async (handle) => {
      await handle.writeFile('first')
      await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      await handle.writeFile(' second')
    })
    expect(await fs.readFile(destination, 'utf8')).toBe('first second')
    expect(await fs.readdir(root)).toEqual(['download.bin'])
  })

  it('does not remove a destination created by another writer during a failed write', async () => {
    const { root, destination } = await fixture()
    await expect(
      atomicNewFile(destination, async (handle) => {
        await handle.writeFile('partial')
        // Simulate another process replacing the visible path while our handle is open.
        await fs.rm(destination, { force: true })
        await fs.writeFile(destination, 'other writer', { flag: 'wx' })
        throw new Error('synthetic write failure')
      })
    ).rejects.toThrow('synthetic write failure')
    expect(await fs.readFile(destination, 'utf8')).toBe('other writer')
    expect(await fs.readdir(root)).toEqual(['download.bin'])
  })

  it('preserves an existing destination', async () => {
    const { root, destination } = await fixture()
    await fs.writeFile(destination, 'existing')
    await expect(
      atomicNewFile(destination, (handle) => handle.writeFile('new'))
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(destination, 'utf8')).toBe('existing')
    expect(await fs.readdir(root)).toEqual(['download.bin'])
  })

  it('does not publish when cancellation occurs during writing', async () => {
    const { root, destination } = await fixture()
    const abort = new AbortController()
    await expect(
      atomicNewFile(
        destination,
        async (handle) => {
          await handle.writeFile('complete but cancelled')
          abort.abort(new Error('synthetic cancellation'))
        },
        abort.signal
      )
    ).rejects.toThrow('synthetic cancellation')
    expect(await fs.readdir(root)).toEqual([])
  })

  it('allows only one concurrent publisher and leaves complete winning bytes', async () => {
    const { root, destination } = await fixture()
    const results = await Promise.allSettled([
      atomicNewFile(destination, (handle) => handle.writeFile('first complete')),
      atomicNewFile(destination, (handle) => handle.writeFile('second complete'))
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'EEXIST' }
    })
    expect(['first complete', 'second complete']).toContain(await fs.readFile(destination, 'utf8'))
    expect(await fs.readdir(root)).toEqual(['download.bin'])
  })

  it('fails closed when the filesystem cannot hard-link, without copy or rename fallback', async () => {
    const { root, destination } = await fixture()
    const error = Object.assign(new Error('synthetic unsupported hard link'), { code: 'ENOTSUP' })
    vi.spyOn(fs, 'link').mockRejectedValueOnce(error)
    const copy = vi.spyOn(fs, 'copyFile')
    const rename = vi.spyOn(fs, 'rename')
    await expect(atomicNewFile(destination, (handle) => handle.writeFile('complete'))).rejects.toBe(
      error
    )
    expect(copy).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
    expect(await fs.readdir(root)).toEqual([])
  })

  it('does not publish after a flush failure', async () => {
    const { root, destination } = await fixture()
    await expect(
      atomicNewFile(destination, async (handle) => {
        await handle.writeFile('complete')
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('synthetic flush failure'))
      })
    ).rejects.toThrow('synthetic flush failure')
    expect(await fs.readdir(root)).toEqual([])
  })

  it('never removes a published file when stage cleanup fails', async () => {
    const { root, destination } = await fixture()
    const unlink = vi
      .spyOn(fs, 'unlink')
      .mockRejectedValueOnce(new Error('synthetic cleanup failure'))
    await atomicNewFile(destination, (handle) => handle.writeFile('complete'))
    expect(await fs.readFile(destination, 'utf8')).toBe('complete')
    expect(unlink).toHaveBeenCalledTimes(1)
    expect(unlink.mock.calls[0][0]).not.toBe(destination)
    expect(await fs.readdir(root)).toHaveLength(2)
  })

  it('creates nothing for an already-cancelled operation', async () => {
    const { root, destination } = await fixture()
    const abort = new AbortController()
    abort.abort(new Error('synthetic cancellation'))
    const write = vi.fn()
    await expect(atomicNewFile(destination, write, abort.signal)).rejects.toThrow(
      'synthetic cancellation'
    )
    expect(write).not.toHaveBeenCalled()
    expect(await fs.readdir(root)).toEqual([])
  })
})
