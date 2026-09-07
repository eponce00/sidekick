import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join, relative, sep } from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Protocol } from 'electron'
import { installBrowserPdfProtocol } from '../bootstrap/artifactProtocol'
import { capturePublicationDirectory } from './publicationDirectory'
import * as publication from './publicationDirectory'
import { atomicNewFile } from './atomicNewFile'
import { NativeBrowserSessionService } from '../services/nativeBrowserSessionService'
import {
  browserPdfPublicationDirectory,
  createBrowserPdfSession,
  revokeBrowserPdfSession
} from '../bootstrap/browserPdfSessionRegistry'

const owned: string[] = []
vi.mock('electron', () => ({ app: {}, net: {}, protocol: {} }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
const links: string[] = []
async function fixture() {
  const tree = await fs.mkdtemp(join(tmpdir(), 'sidekick-publication-guard-'))
  owned.push(tree)
  const root = join(tree, 'workspace'),
    parent = join(root, 'reports'),
    sibling = join(tree, 'sibling'),
    parked = join(root, 'parked')
  await fs.mkdir(parent, { recursive: true })
  await fs.mkdir(sibling)
  return { tree, root, parent, sibling, parked, target: join(parent, 'result.pdf') }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const link of links.splice(0)) await fs.unlink(link)
  for (const tree of owned.splice(0)) {
    const actual = await fs.realpath(tree),
      temp = await fs.realpath(tmpdir()),
      rel = relative(temp, actual)
    expect(
      rel &&
        !rel.startsWith(`..${sep}`) &&
        rel !== '..' &&
        !isAbsolute(rel) &&
        dirname(actual) === temp
    ).toBeTruthy()
    expect(rel.startsWith('sidekick-publication-guard-')).toBe(true)
    await fs.rm(actual, { recursive: true, force: true })
  }
})
async function rebind(f: Awaited<ReturnType<typeof fixture>>) {
  await fs.rename(f.parent, f.parked)
  await fs.symlink(f.sibling, f.parent, process.platform === 'win32' ? 'junction' : 'dir')
  links.push(f.parent)
}

it('rejects actual parent junction rebinding during the download network await', async () => {
  const f = await fixture()
  if (process.env.SIDEKICK_PUBLICATION_OLD_FLOW === '1') {
    // Test-only control: remove precisely the new publication guard, preserving
    // the actual resolver, awaited fetch, filesystem mutation, and publisher.
    vi.spyOn(publication, 'capturePublicationDirectory').mockResolvedValue({
      prepare: async () => {},
      assertUnchanged: async () => {}
    })
  }
  const service = {
    getSession: () => ({}),
    withSessionLock: (_s: unknown, _o: unknown, body: (signal: AbortSignal) => unknown) =>
      body(new AbortController().signal),
    getTab: () => ({
      surface: {
        fetch: async () => {
          await rebind(f)
          return new Response('synthetic')
        }
      }
    }),
    assertAutomatedMutationAllowed: async () => {},
    normalizeNavigationUrl: async (url: string) => url
  }
  await expect(
    NativeBrowserSessionService.prototype.download.call(service as never, {
      sessionId: 'fixture',
      url: 'https://fixture.invalid/file.pdf',
      workspaceRoot: f.root,
      destination: 'reports/result.pdf'
    })
  ).rejects.toThrow('Publication directory changed')
  expect(await fs.readdir(f.sibling)).toEqual([])
  expect(await fs.readdir(f.parked)).toEqual([])
})

it.each(['parent', 'root'])(
  'detects replacement with the same realpath string using %s inode identity',
  async (which) => {
    const f = await fixture(),
      guard = await capturePublicationDirectory(f.root, f.parent)
    if (which === 'parent') {
      await fs.rename(f.parent, f.parked)
      await fs.mkdir(f.parent)
    } else {
      await fs.rename(f.root, join(f.tree, 'old-root'))
      await fs.mkdir(f.parent, { recursive: true })
    }
    await expect(guard.prepare()).rejects.toThrow('Publication directory changed')
    expect(await fs.readdir(f.parent)).toEqual([])
  }
)

it('rechecks before publication and does not unlink a rebound stage pathname', async () => {
  const f = await fixture(),
    guard = await capturePublicationDirectory(f.root, f.parent)
  await guard.prepare()
  let validations = 0,
    stageName = ''
  await expect(
    atomicNewFile(
      f.target,
      async (handle) => {
        await handle.writeFile('synthetic')
      },
      undefined,
      async () => {
        if (++validations === 2) {
          stageName = (await fs.readdir(f.parent))[0]
          await rebind(f)
          await fs.writeFile(join(f.sibling, stageName), 'keep')
        }
        await guard.assertUnchanged()
      }
    )
  ).rejects.toThrow('Publication directory changed')
  expect(await fs.readFile(join(f.sibling, stageName), 'utf8')).toBe('keep')
  expect(await fs.readFile(join(f.parked, stageName), 'utf8')).toBe('synthetic')
  expect(await fs.readdir(f.sibling)).toEqual([stageName])
})

it('keeps normal collision and cancellation semantics with the validator enabled', async () => {
  const f = await fixture(),
    guard = await capturePublicationDirectory(f.root, f.parent)
  await guard.prepare()
  const validate = () => guard.assertUnchanged()
  await atomicNewFile(f.target, (handle) => handle.writeFile('first'), undefined, validate)
  await expect(
    atomicNewFile(f.target, (handle) => handle.writeFile('second'), undefined, validate)
  ).rejects.toMatchObject({ code: 'EEXIST' })
  const abort = new AbortController()
  await expect(
    atomicNewFile(
      join(f.parent, 'cancelled'),
      async (handle) => {
        await handle.writeFile('partial')
        abort.abort()
      },
      abort.signal,
      validate
    )
  ).rejects.toBeDefined()
  expect(await fs.readdir(f.parent)).toEqual(['result.pdf'])
  expect(await fs.readFile(f.target, 'utf8')).toBe('first')
})

it('does not replace a write failure or unlink a stage when cleanup validation fails', async () => {
  const f = await fixture(),
    failure = new Error('original synthetic write failure')
  let changed = false
  await expect(
    atomicNewFile(
      f.target,
      async (handle) => {
        await handle.writeFile('stage')
        changed = true
        throw failure
      },
      undefined,
      async () => {
        if (changed) throw new Error('directory changed')
      }
    )
  ).rejects.toBe(failure)
  const entries = await fs.readdir(f.parent)
  expect(entries.length).toBe(1)
  expect(entries[0]).toMatch(/^\.sidekick-download-.*\.partial$/)
})

it('rejects before staging when the prepared directory has changed', async () => {
  const f = await fixture(),
    guard = await capturePublicationDirectory(f.root, f.parent)
  await guard.prepare()
  await rebind(f)
  await expect(
    atomicNewFile(
      f.target,
      (handle) => handle.writeFile('no write'),
      undefined,
      () => guard.assertUnchanged()
    )
  ).rejects.toThrow('Publication directory changed')
  expect(await fs.readdir(f.sibling)).toEqual([])
})

it('does not create a missing output directory during readonly PDF capture', async () => {
  const f = await fixture(),
    output = join(f.root, 'missing', 'downloads')
  const session = createBrowserPdfSession(join(f.parent, 'source.pdf'), 'fixture', {
    outputDirectory: output
  })
  try {
    const guard = await browserPdfPublicationDirectory(session)
    await expect(fs.stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    await guard.prepare()
    await guard.assertUnchanged()
    expect((await fs.stat(output)).isDirectory()).toBe(true)
  } finally {
    revokeBrowserPdfSession(session.token)
  }
})

it('rejects a filled-copy directory rebound after eager session capture', async () => {
  const f = await fixture(),
    session = createBrowserPdfSession(join(f.parent, 'source.pdf'), 'fixture', {
      publicationRoot: f.root
    })
  try {
    const guard = await browserPdfPublicationDirectory(session)
    await rebind(f)
    await expect(guard.prepare()).rejects.toThrow('Publication directory changed')
    expect(await fs.readdir(f.sibling)).toEqual([])
  } finally {
    revokeBrowserPdfSession(session.token)
  }
})

it('actual PDF save handler rejects rebinding while the request body is pending', async () => {
  const f = await fixture(),
    session = createBrowserPdfSession(join(f.parent, 'source.pdf'), 'fixture', {
      publicationRoot: f.root
    })
  try {
    await browserPdfPublicationDirectory(session)
    let handler!: (request: Request) => Promise<Response>
    await installBrowserPdfProtocol({
      handle: async (_scheme: string, callback: typeof handler) => {
        handler = callback
      }
    } as unknown as Protocol)
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      }
    })
    const response = handler(
      new Request(`sidekick-pdf://viewer/${session.token}/save`, {
        method: 'POST',
        body,
        duplex: 'half'
      } as RequestInit)
    )
    await rebind(f)
    controller.enqueue(new TextEncoder().encode('%PDF-synthetic'))
    controller.close()
    expect((await response).status).toBe(400)
    expect(session.lastOutputPath).toBeUndefined()
    expect(await fs.readdir(f.sibling)).toEqual([])
  } finally {
    revokeBrowserPdfSession(session.token)
  }
})

it('rejects revocation during eager capture without creating a missing directory', async () => {
  const f = await fixture(),
    output = join(f.root, 'absent'),
    session = createBrowserPdfSession(join(f.parent, 'source.pdf'), 'fixture', {
      outputDirectory: output
    })
  revokeBrowserPdfSession(session.token)
  await expect(browserPdfPublicationDirectory(session)).rejects.toThrow()
  await new Promise((done) => setImmediate(done))
  await expect(fs.stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not adopt a directory that unexpectedly appears after missing-path capture', async () => {
  const f = await fixture(),
    output = join(f.root, 'absent'),
    guard = await capturePublicationDirectory(output, output, true)
  await fs.mkdir(output)
  await expect(guard.prepare()).rejects.toThrow('Publication directory changed')
})

it('permits a later retry after request cancellation while checking an existing directory', async () => {
  const f = await fixture(),
    guard = await capturePublicationDirectory(f.root, f.parent)
  let release!: () => void, entered!: () => void
  const wait = new Promise<void>((yes) => {
      release = yes
    }),
    started = new Promise<void>((yes) => {
      entered = yes
    })
  const original = fs.stat.bind(fs)
  vi.spyOn(fs, 'stat').mockImplementationOnce((async (...args: Parameters<typeof fs.stat>) => {
    entered()
    await wait
    return original(...args)
  }) as typeof fs.stat)
  const controller = new AbortController(),
    pending = guard.prepare(controller.signal)
  await started
  controller.abort()
  release()
  await expect(pending).rejects.toBeDefined()
  await expect(guard.prepare()).resolves.toBeUndefined()
})

it('binds its own completed mkdir before reporting cancellation and permits another request', async () => {
  const f = await fixture(),
    output = join(f.root, 'created'),
    guard = await capturePublicationDirectory(output, output, true)
  const controller = new AbortController(),
    original = fs.mkdir.bind(fs)
  vi.spyOn(fs, 'mkdir').mockImplementationOnce((async (...args: Parameters<typeof fs.mkdir>) => {
    const result = await original(...args)
    controller.abort()
    return result
  }) as typeof fs.mkdir)
  await expect(guard.prepare(controller.signal)).rejects.toBeDefined()
  await expect(guard.prepare()).resolves.toBeUndefined()
  await expect(guard.assertUnchanged()).resolves.toBeUndefined()
})

it('observes eager capture rejection even when a readonly session never saves', async () => {
  const f = await fixture(),
    blocked = join(f.root, 'not-directory')
  await fs.writeFile(blocked, 'synthetic')
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  const session = createBrowserPdfSession(join(f.parent, 'source.pdf'), 'fixture', {
    outputDirectory: blocked
  })
  try {
    await new Promise((done) => setImmediate(done))
    await new Promise((done) => setImmediate(done))
    expect(unhandled).not.toHaveBeenCalled()
    await expect(browserPdfPublicationDirectory(session)).rejects.toThrow(
      'Publication directory changed'
    )
  } finally {
    revokeBrowserPdfSession(session.token)
    process.off('unhandledRejection', unhandled)
  }
})
