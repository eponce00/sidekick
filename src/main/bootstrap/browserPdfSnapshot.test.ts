import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Protocol } from 'electron'

const fixture = vi.hoisted(() => ({
  content: 'version-A',
  size: 9,
  regular: true,
  revision: 1,
  chunkSize: 65536,
  gate: undefined as (() => Promise<void>) | undefined,
  open: vi.fn(),
  close: vi.fn(),
  stat: vi.fn(),
  read: vi.fn(),
  render: vi.fn()
}))
vi.mock('electron', () => ({ app: {}, net: {}, protocol: {} }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('fs', () => ({
  constants: { O_RDONLY: 0, O_NONBLOCK: 2048 },
  existsSync: () => true,
  promises: { open: fixture.open }
}))
vi.mock('./browserPdfRenderer', () => ({ renderBrowserPdfPage: fixture.render }))
import { installBrowserPdfProtocol } from './artifactProtocol'
import {
  createBrowserPdfSession,
  browserPdfSessionBytes,
  browserPdfViewerUrl,
  revokeBrowserPdfSession,
  revokeBrowserPdfSessionsByOwner
} from './browserPdfSessionRegistry'
import { MAX_BROWSER_PDF_SOURCE_BYTES } from './browserPdfSnapshot'

beforeEach(() => {
  vi.resetAllMocks()
  Object.assign(fixture, {
    content: 'version-A',
    size: 9,
    regular: true,
    revision: 1,
    chunkSize: 65536,
    gate: undefined
  })
  fixture.stat.mockImplementation(async () => ({
    isFile: () => fixture.regular,
    size: fixture.size,
    mtimeMs: fixture.revision,
    ctimeMs: fixture.revision
  }))
  fixture.read.mockImplementation(
    async (target: Buffer, offset: number, length: number, position: number) => {
      await fixture.gate?.()
      const source = Buffer.from(fixture.content)
      const count = Math.min(length, fixture.chunkSize, Math.max(0, source.length - position))
      source.copy(target, offset, position, position + count)
      return { bytesRead: count }
    }
  )
  fixture.open.mockResolvedValue({ stat: fixture.stat, read: fixture.read, close: fixture.close })
  fixture.close.mockResolvedValue(undefined)
  fixture.render.mockImplementation(async (bytes: Uint8Array) => Buffer.from(bytes))
})
afterEach(() => revokeBrowserPdfSessionsByOwner('fixture-owner'))
const session = () => createBrowserPdfSession('untouched-original.pdf', 'fixture-owner')

describe('immutable bounded PDF session snapshot', () => {
  it.each([
    ['oversized', 413],
    ['changed', 409],
    ['missing', 404],
    ['unreadable', 400],
    ['invalid', 400]
  ] as const)('returns safe actionable protocol errors for %s', async (kind, status) => {
    const current = session()
    if (kind === 'oversized') fixture.size = MAX_BROWSER_PDF_SOURCE_BYTES + 1
    if (kind === 'changed') fixture.content = 'short'
    if (kind === 'invalid') fixture.regular = false
    if (kind === 'missing' || kind === 'unreadable') {
      fixture.open.mockRejectedValue(
        Object.assign(new Error('private/source/path'), {
          code: kind === 'missing' ? 'ENOENT' : 'EACCES'
        })
      )
    }
    let handler!: (request: Request) => Promise<Response>
    await installBrowserPdfProtocol({
      handle: (_scheme: string, callback: typeof handler) => {
        handler = callback
      }
    } as unknown as Protocol)
    const response = await handler(
      new Request(browserPdfViewerUrl(current).replace('index.html', 'document.pdf'))
    )
    expect(response.status).toBe(status)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = await response.text()
    expect(body).not.toContain('private/source/path')
    expect(body).not.toContain('untouched-original.pdf')
    expect(JSON.parse(body).error).toMatch(/PDF/)
  })
  it('does not read a session revoked before its first request', async () => {
    const current = session()
    revokeBrowserPdfSession(current.token)
    await expect(browserPdfSessionBytes(current)).rejects.toThrow('no longer available')
    expect(fixture.open).not.toHaveBeenCalled()
  })
  it('memoizes open failures and never tries a replacement source', async () => {
    const current = session()
    fixture.open.mockRejectedValueOnce(new Error('synthetic open failure'))
    await expect(browserPdfSessionBytes(current)).rejects.toThrow(
      'Could not read the PDF source safely'
    )
    await expect(browserPdfSessionBytes(current)).rejects.toThrow(
      'Could not read the PDF source safely'
    )
    expect(fixture.open).toHaveBeenCalledOnce()
    expect(fixture.close).not.toHaveBeenCalled()
  })
  it('does not expose a successful snapshot if closing its handle failed', async () => {
    fixture.close.mockRejectedValue(new Error('synthetic close failure'))
    const current = session()
    await expect(browserPdfSessionBytes(current)).rejects.toThrow(
      'Could not read the PDF source safely'
    )
    await expect(browserPdfSessionBytes(current)).rejects.toThrow(
      'Could not read the PDF source safely'
    )
    expect(fixture.open).toHaveBeenCalledOnce()
  })
  it('keeps document, cached pages and new scale/page renders on the same version', async () => {
    const current = session()
    let handler!: (request: Request) => Promise<Response>
    await installBrowserPdfProtocol({
      handle: (_scheme: string, callback: typeof handler) => {
        handler = callback
      }
    } as unknown as Protocol)
    const base = browserPdfViewerUrl(current).replace('index.html', '')
    const request = async (route: string) => (await handler(new Request(base + route))).text()
    expect(await request('document.pdf')).toBe('version-A')
    expect(await request('page-1.png?scale=2')).toBe('version-A')
    fixture.content = 'version-B'
    fixture.revision++
    expect(await request('page-2.png?scale=2')).toBe('version-A')
    expect(await request('page-1.png?scale=2')).toBe('version-A')
    expect(await request('page-1.png?scale=3')).toBe('version-A')
    expect(fixture.open).toHaveBeenCalledOnce()
    expect(fixture.close).toHaveBeenCalledOnce()
    expect(current.sourcePath).toBe('untouched-original.pdf')
    revokeBrowserPdfSession(current.token)
    expect((await handler(new Request(base + 'document.pdf'))).status).toBe(404)
    expect(current.renderedPages.size).toBe(0)
  })

  it('shares concurrent reads but isolates mutation and transfer by consumers', async () => {
    const current = session()
    const [first, second] = await Promise.all([
      browserPdfSessionBytes(current),
      browserPdfSessionBytes(current)
    ])
    first[0] = 0
    structuredClone(first, { transfer: [first.buffer] })
    expect(Buffer.from(second).toString()).toBe('version-A')
    expect(Buffer.from(await browserPdfSessionBytes(current)).toString()).toBe('version-A')
    expect(fixture.open).toHaveBeenCalledOnce()
  })

  it.each([0, -1, NaN, Infinity, 1.5, MAX_BROWSER_PDF_SOURCE_BYTES + 1])(
    'rejects invalid size %s before reading',
    async (size) => {
      fixture.size = size
      await expect(browserPdfSessionBytes(session())).rejects.toThrow(
        size > MAX_BROWSER_PDF_SOURCE_BYTES && Number.isSafeInteger(size)
          ? '64 MiB'
          : 'regular file'
      )
      expect(fixture.read).not.toHaveBeenCalled()
      expect(fixture.close).toHaveBeenCalledOnce()
    }
  )
  it('rejects nonregular files and memoizes failure instead of retrying a replacement', async () => {
    fixture.regular = false
    const current = session()
    await expect(browserPdfSessionBytes(current)).rejects.toThrow('regular file')
    fixture.regular = true
    await expect(browserPdfSessionBytes(current)).rejects.toThrow('regular file')
    expect(fixture.open).toHaveBeenCalledOnce()
  })
  it.each(['growth', 'shrink', 'metadata'])(
    'rejects %s during reading and closes the handle',
    async (kind) => {
      if (kind === 'growth') fixture.content += 'x'
      if (kind === 'shrink') fixture.content = 'short'
      if (kind === 'metadata')
        fixture.gate = async () => {
          fixture.revision++
        }
      await expect(browserPdfSessionBytes(session())).rejects.toThrow('changed')
      expect(fixture.close).toHaveBeenCalledOnce()
    }
  )
  it('handles partial reads at bounded positions and probes only one extra byte', async () => {
    fixture.chunkSize = 2
    expect(Buffer.from(await browserPdfSessionBytes(session())).toString()).toBe('version-A')
    expect(fixture.read.mock.calls.map((call) => call[3])).toEqual([0, 2, 4, 6, 8, 9])
    expect(fixture.read.mock.calls.at(-1)?.[2]).toBe(1)
  })
  it('rejects revocation during reading, closes the handle and cannot reopen', async () => {
    const current = session()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    fixture.gate = () => {
      entered()
      return new Promise<void>((resolve) => {
        release = resolve
      })
    }
    const reading = browserPdfSessionBytes(current)
    await started
    revokeBrowserPdfSession(current.token)
    release()
    await expect(reading).rejects.toThrow('no longer available')
    await expect(browserPdfSessionBytes(current)).rejects.toThrow('no longer available')
    expect(fixture.close).toHaveBeenCalledOnce()
    expect(fixture.open).toHaveBeenCalledOnce()
  })
  it('preserves original read failure if cleanup also fails', async () => {
    fixture.content = 'short'
    fixture.close.mockRejectedValue(new Error('synthetic close failure'))
    await expect(browserPdfSessionBytes(session())).rejects.toThrow('changed')
    expect(fixture.close).toHaveBeenCalledOnce()
  })
})
