import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'path'
import type { Protocol } from 'electron'

const fixture = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  writeError: false,
  linkUnsupported: false,
  onWrite: undefined as (() => void) | undefined,
  onLink: undefined as (() => void) | undefined,
  limit: undefined as number | undefined,
  session: {
    token: '00000000-0000-4000-8000-000000000000',
    sourcePath: 'fixture/source.pdf',
    sourceName: 'form.pdf',
    outputDirectory: 'fixture',
    lastOutputPath: undefined as string | undefined,
    renderedPages: new Map()
  },
  open: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  readBody: vi.fn()
}))
const io = vi.hoisted(() => {
  const exists = (name: string) => {
    if (fixture.files.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
  }
  const write = async (name: string, bytes: Uint8Array) => {
    fixture.files.set(name, Buffer.from(bytes).subarray(0, 5))
    fixture.onWrite?.()
    if (fixture.writeError)
      throw Object.assign(new Error('synthetic disk write failure'), { code: 'EIO' })
    fixture.files.set(name, Buffer.from(bytes))
  }
  return {
    realpath: vi.fn(async (name: string) => resolve(name)),
    stat: vi.fn(async () => ({ isDirectory: () => true, dev: 1n, ino: 1n })),
    mkdir: vi.fn(async () => {}),
    lstat: vi.fn(async (name: string) => {
      if (!fixture.files.has(name)) throw Object.assign(new Error('absent'), { code: 'ENOENT' })
      return {}
    }),
    writeFile: vi.fn(async (name: string, bytes: Uint8Array, options: { flag: string }) => {
      expect(options.flag).toBe('wx')
      exists(name)
      await write(name, bytes)
    }),
    open: fixture.open.mockImplementation(async (name: string, flags: string, mode: number) => {
      expect(flags).toBe('wx')
      expect(mode).toBe(0o600)
      exists(name)
      fixture.files.set(name, Buffer.alloc(0))
      return {
        writeFile: (bytes: Uint8Array) => write(name, bytes),
        sync: async () => {},
        close: async () => {}
      }
    }),
    link: fixture.link.mockImplementation(async (stage: string, target: string) => {
      if (fixture.linkUnsupported)
        throw Object.assign(new Error('synthetic hard-link unsupported'), { code: 'ENOTSUP' })
      exists(target)
      fixture.files.set(target, fixture.files.get(stage)!)
      fixture.onLink?.()
    }),
    unlink: fixture.unlink.mockImplementation(async (name: string) => {
      fixture.files.delete(name)
    })
  }
})
vi.mock('fs', () => ({ existsSync: () => false, promises: io }))
vi.mock('electron', () => ({ app: {}, net: {}, protocol: {} }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('./browserPdfRenderer', () => ({ renderBrowserPdfPage: vi.fn() }))
vi.mock('../utils/boundedRequestBody', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/boundedRequestBody')>()
  return {
    ...actual,
    readBoundedRequestBody: fixture.readBody.mockImplementation(
      (request: Request, maxBytes: number, signal?: AbortSignal) =>
        actual.readBoundedRequestBody(request, fixture.limit ?? maxBytes, signal)
    )
  }
})
import { installBrowserPdfProtocol } from './artifactProtocol'
import {
  createBrowserPdfSession,
  revokeBrowserPdfSession,
  revokeBrowserPdfSessionsByOwner,
  browserPdfSessionSignal
} from './browserPdfSessionRegistry'

let handler: (request: Request) => Promise<Response>
const bytes = Buffer.from('%PDF-synthetic-prefix-only-not-a-document')
let url: string
function request(signal?: AbortSignal) {
  return new Request(url, { method: 'POST', body: bytes, signal })
}
beforeEach(async () => {
  vi.clearAllMocks()
  fixture.files.clear()
  fixture.writeError = false
  fixture.linkUnsupported = false
  fixture.onWrite = undefined
  fixture.onLink = undefined
  fixture.limit = undefined
  fixture.session.lastOutputPath = undefined
  fixture.session.sourceName = 'form.pdf'
  fixture.session = createBrowserPdfSession('fixture/source.pdf', 'save-fixture', {
    sourceName: 'form.pdf',
    outputDirectory: 'fixture'
  }) as typeof fixture.session
  url = `sidekick-pdf://viewer/${fixture.session.token}/save`
  await installBrowserPdfProtocol({
    handle: async (_scheme: string, callback: typeof handler) => {
      handler = callback
    }
  } as unknown as Protocol)
})
afterEach(() => revokeBrowserPdfSessionsByOwner('save-fixture'))

describe('PDF save protocol atomic publication', () => {
  it('leaves no partial final file after write failure and retries the original available name', async () => {
    fixture.writeError = true
    expect((await handler(request())).status).toBe(400)
    expect(fixture.files.size).toBe(0)
    expect(fixture.session.lastOutputPath).toBeUndefined()
    fixture.writeError = false
    const result = await handler(request())
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ outputPath: join('fixture', 'form-filled.pdf') })
    expect(fixture.files.get(join('fixture', 'form-filled.pdf'))).toEqual(bytes)
  })

  it('skips existing names without rewriting stages and preserves suffix semantics', async () => {
    fixture.files.set(join('fixture', 'form-filled.pdf'), Buffer.from('existing one'))
    fixture.files.set(join('fixture', 'form-filled-2.pdf'), Buffer.from('existing two'))
    const response = await handler(request())
    expect(await response.json()).toEqual({ outputPath: join('fixture', 'form-filled-3.pdf') })
    expect(fixture.files.get(join('fixture', 'form-filled.pdf'))?.toString()).toBe('existing one')
    expect(fixture.files.get(join('fixture', 'form-filled-2.pdf'))?.toString()).toBe('existing two')
    expect(fixture.open).toHaveBeenCalledOnce()
  })

  it('handles a competing writer after preflight without overwriting or removing its file', async () => {
    fixture.onWrite = () => {
      fixture.files.set(join('fixture', 'form-filled.pdf'), Buffer.from('competing writer'))
      fixture.onWrite = undefined
    }
    const response = await handler(request())
    expect(await response.json()).toEqual({ outputPath: join('fixture', 'form-filled-2.pdf') })
    expect(fixture.files.get(join('fixture', 'form-filled.pdf'))?.toString()).toBe(
      'competing writer'
    )
    expect([...fixture.files.keys()].some((name) => name.endsWith('.partial'))).toBe(false)
  })

  it('fails closed on unsupported hard links', async () => {
    fixture.linkUnsupported = true
    expect((await handler(request())).status).toBe(400)
    expect(fixture.files.size).toBe(0)
    expect(fixture.session.lastOutputPath).toBeUndefined()
  })

  it('honors cancellation before publication without deleting any final file', async () => {
    const abort = new AbortController()
    fixture.onWrite = () => abort.abort()
    expect((await handler(request(abort.signal))).status).toBe(400)
    expect(fixture.link).not.toHaveBeenCalled()
    expect(fixture.files.size).toBe(0)
  })

  it.each([undefined, '1'])(
    'rejects actual body overflow with header %s before any disk write',
    async (declared) => {
      fixture.limit = 8
      let pulls = 0
      const cancel = vi.fn()
      const chunks = [Buffer.from('%PDF-'), Buffer.from('1234'), Buffer.from('unread')]
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (pulls < chunks.length) controller.enqueue(chunks[pulls++])
            else controller.close()
          },
          cancel
        },
        { highWaterMark: 0 }
      )
      const input = new Request(url, {
        method: 'POST',
        body,
        duplex: 'half',
        headers: declared ? { 'content-length': declared } : undefined
      } as RequestInit)
      const arrayBuffer = vi.spyOn(input, 'arrayBuffer')
      expect((await handler(input)).status).toBe(413)
      expect(fixture.readBody).toHaveBeenCalledWith(
        input,
        256 * 1024 * 1024,
        expect.any(AbortSignal)
      )
      expect(pulls).toBe(2)
      expect(cancel).toHaveBeenCalledOnce()
      expect(arrayBuffer).not.toHaveBeenCalled()
      expect(fixture.files.size).toBe(0)
      expect(fixture.open).not.toHaveBeenCalled()
    }
  )

  it('retains method and invalid-prefix response semantics', async () => {
    expect((await handler(new Request(url))).status).toBe(405)
    expect((await handler(new Request(url, { method: 'POST', body: 'not-pdf' }))).status).toBe(400)
    expect(fixture.files.size).toBe(0)
  })

  it('preserves the last successful output when a subsequent save fails', async () => {
    const first = await handler(request())
    const saved = (await first.json()) as { outputPath: string }
    fixture.writeError = true
    expect((await handler(request())).status).toBe(400)
    expect(fixture.session.lastOutputPath).toBe(saved.outputPath)
    expect([...fixture.files.keys()]).toEqual([saved.outputPath])
    expect(fixture.files.get(saved.outputPath)).toEqual(bytes)
  })

  it.each([
    ['Report.PDF', 'Report-filled.PDF'],
    ['report.txt', 'report-filled.pdf']
  ])('preserves output naming for %s', async (sourceName, expectedName) => {
    fixture.session.sourceName = sourceName
    expect(await (await handler(request())).json()).toEqual({
      outputPath: join('fixture', expectedName)
    })
  })

  it('rejects overdeclared bodies before reading and cancels transport', async () => {
    fixture.limit = 8
    const pull = vi.fn()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
    const input = new Request(url, {
      method: 'POST',
      body,
      headers: { 'content-length': '9' },
      duplex: 'half'
    } as RequestInit)
    expect((await handler(input)).status).toBe(413)
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
    expect(fixture.files.size).toBe(0)
  })

  it('cancels a pending request read without starting publication', async () => {
    const abort = new AbortController()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const input = new Request(url, {
      method: 'POST',
      body,
      signal: abort.signal,
      duplex: 'half'
    } as RequestInit)
    const pending = handler(input)
    abort.abort()
    expect((await pending).status).toBe(400)
    expect(cancel).toHaveBeenCalledOnce()
    expect(fixture.open).not.toHaveBeenCalled()
    expect(fixture.files.size).toBe(0)
  })

  it('revocation promptly cancels an unresolved body read without publication', async () => {
    let entered!: () => void
    const reading = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pull = vi.fn(() => entered())
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
    const input = new Request(url, { method: 'POST', body, duplex: 'half' } as RequestInit)
    const pending = handler(input)
    await reading
    revokeBrowserPdfSession(fixture.session.token)
    expect((await pending).status).toBe(400)
    expect(input.signal.aborted).toBe(false)
    expect(pull).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    expect(fixture.open).not.toHaveBeenCalled()
    expect(fixture.files.size).toBe(0)
    expect(fixture.session.lastOutputPath).toBeUndefined()
  })

  it('revocation during stage writing prevents the hard-link commit', async () => {
    fixture.onWrite = () => revokeBrowserPdfSession(fixture.session.token)
    expect((await handler(request())).status).toBe(400)
    expect(fixture.link).not.toHaveBeenCalled()
    expect(fixture.files.size).toBe(0)
    expect(fixture.session.lastOutputPath).toBeUndefined()
  })

  it('revocation after the hard-link commit never deletes the published copy', async () => {
    fixture.onLink = () => revokeBrowserPdfSession(fixture.session.token)
    const response = await handler(request())
    expect(response.status).toBe(200)
    const destination = join('fixture', 'form-filled.pdf')
    expect(fixture.files.get(destination)).toEqual(bytes)
    expect([...fixture.files.keys()]).toEqual([destination])
    expect(fixture.unlink.mock.calls.every(([name]) => name !== destination)).toBe(true)
  })

  it('returns only aborted signals for revoked or foreign session objects', () => {
    const current = fixture.session as ReturnType<typeof createBrowserPdfSession>
    const signal = browserPdfSessionSignal(current)
    expect(signal.aborted).toBe(false)
    expect(browserPdfSessionSignal({ ...current }).aborted).toBe(true)
    revokeBrowserPdfSession(current.token)
    expect(signal.aborted).toBe(true)
    expect(browserPdfSessionSignal(current).aborted).toBe(true)
  })
})
