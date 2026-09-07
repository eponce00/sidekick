import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir, release } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { capturePublicationDirectory } from '../src/main/utils/publicationDirectory'
import { atomicNewFile } from '../src/main/utils/atomicNewFile'

assert.equal(process.platform, 'linux')
assert.equal(process.env.SIDEKICK_PUBLICATION_LINUX_FIXTURE, '1')
console.log(
  'PUBLICATION_LINUX_ENV=' +
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      kernel: release(),
      fixtureFilesystem: 'container_tmpfs'
    })
)
const trees: string[] = [],
  links: string[] = []
async function fixture() {
  const tree = await fs.mkdtemp(join(tmpdir(), 'sidekick-publication-linux-'))
  trees.push(tree)
  const root = join(tree, 'workspace'),
    parent = join(root, 'reports'),
    sibling = join(tree, 'sibling'),
    parked = join(root, 'parked')
  await fs.mkdir(parent, { recursive: true })
  await fs.mkdir(sibling)
  return { tree, root, parent, sibling, parked, target: join(parent, 'result') }
}
async function rebind(f: Awaited<ReturnType<typeof fixture>>) {
  await fs.rename(f.parent, f.parked)
  await fs.symlink(f.sibling, f.parent, 'dir')
  links.push(f.parent)
}
afterEach(async () => {
  for (const link of links.splice(0)) await fs.unlink(link)
  for (const tree of trees.splice(0)) {
    const actual = await fs.realpath(tree),
      temporary = await fs.realpath(tmpdir()),
      rel = relative(temporary, actual)
    assert.ok(
      rel.startsWith('sidekick-publication-linux-') &&
        !isAbsolute(rel) &&
        dirname(actual) === temporary
    )
    await fs.rm(actual, { recursive: true, force: true })
  }
})
test('ordinary publication, exclusive collision, and mode0600', async () => {
  const f = await fixture(),
    guard = await capturePublicationDirectory(f.root, f.parent)
  await guard.prepare()
  const validate = () => guard.assertUnchanged()
  await atomicNewFile(f.target, (handle) => handle.writeFile('first'), undefined, validate)
  assert.equal((await fs.stat(f.target)).mode & 0o777, 0o600)
  await assert.rejects(
    atomicNewFile(f.target, (handle) => handle.writeFile('second'), undefined, validate),
    { code: 'EEXIST' }
  )
  assert.equal(await fs.readFile(f.target, 'utf8'), 'first')
  assert.deepEqual(await fs.readdir(f.parent), ['result'])
})
test('same-path parent replacement is rejected by identity', async () => {
  const f = await fixture(),
    guard = await capturePublicationDirectory(f.root, f.parent)
  await fs.rename(f.parent, f.parked)
  await fs.mkdir(f.parent)
  await assert.rejects(guard.prepare(), /Publication directory changed/)
})
test('same-path authorized-root replacement is rejected by identity', async () => {
  const f = await fixture(),
    guard = await capturePublicationDirectory(f.root, f.parent)
  await fs.rename(f.root, join(f.tree, 'old-root'))
  await fs.mkdir(f.parent, { recursive: true })
  await assert.rejects(guard.prepare(), /Publication directory changed/)
})
test('symlink rebinding before staging writes nothing in the sibling', async () => {
  const f = await fixture(),
    guard = await capturePublicationDirectory(f.root, f.parent)
  await guard.prepare()
  await rebind(f)
  await assert.rejects(
    atomicNewFile(
      f.target,
      (handle) => handle.writeFile('blocked'),
      undefined,
      () => guard.assertUnchanged()
    ),
    /Publication directory changed/
  )
  assert.deepEqual(await fs.readdir(f.sibling), [])
})
test('pre-link rebinding blocks publication and cleanup does not unlink the sibling sentinel', async () => {
  const f = await fixture(),
    guard = await capturePublicationDirectory(f.root, f.parent)
  await guard.prepare()
  let count = 0,
    stage = ''
  await assert.rejects(
    atomicNewFile(
      f.target,
      (handle) => handle.writeFile('stage'),
      undefined,
      async () => {
        if (++count === 2) {
          stage = (await fs.readdir(f.parent))[0]
          await rebind(f)
          await fs.writeFile(join(f.sibling, stage), 'keep')
        }
        await guard.assertUnchanged()
      }
    ),
    /Publication directory changed/
  )
  assert.equal(await fs.readFile(join(f.sibling, stage), 'utf8'), 'keep')
  assert.equal(await fs.readFile(join(f.parked, stage), 'utf8'), 'stage')
  assert.deepEqual(await fs.readdir(f.sibling), [stage])
})
test('readonly missing-directory capture does not mkdir; explicit prepare creates it', async () => {
  const f = await fixture(),
    directory = join(f.root, 'missing', 'downloads'),
    guard = await capturePublicationDirectory(directory, directory, true)
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' })
  await guard.prepare()
  await guard.assertUnchanged()
  assert.ok((await fs.stat(directory)).isDirectory())
})
test('unexpected creation after capture is rejected', async () => {
  const f = await fixture(),
    directory = join(f.root, 'unexpected'),
    guard = await capturePublicationDirectory(directory, directory, true)
  await fs.mkdir(directory)
  await assert.rejects(guard.prepare(), /Publication directory changed/)
})
test('cancelled existing-directory prepare allows a fresh request', async (t) => {
  const f = await fixture(),
    guard = await capturePublicationDirectory(f.root, f.parent),
    original = fs.stat.bind(fs)
  let release!: () => void, enter!: () => void
  const pending = new Promise<void>((yes) => {
      release = yes
    }),
    entered = new Promise<void>((yes) => {
      enter = yes
    })
  t.mock.method(
    fs,
    'stat',
    async (...args: Parameters<typeof fs.stat>) => {
      enter()
      await pending
      return original(...args)
    },
    { times: 1 }
  )
  const controller = new AbortController(),
    preparing = guard.prepare(controller.signal)
  await entered
  controller.abort()
  release()
  await assert.rejects(preparing)
  await guard.prepare()
  await guard.assertUnchanged()
})
test('cancel after own mkdir binds identity for later request', async (t) => {
  const f = await fixture(),
    directory = join(f.root, 'created'),
    guard = await capturePublicationDirectory(directory, directory, true),
    original = fs.mkdir.bind(fs),
    controller = new AbortController()
  t.mock.method(
    fs,
    'mkdir',
    async (...args: Parameters<typeof fs.mkdir>) => {
      const result = await original(...args)
      controller.abort()
      return result
    },
    { times: 1 }
  )
  await assert.rejects(guard.prepare(controller.signal))
  await guard.prepare()
  await guard.assertUnchanged()
})
test('cancelled write preserves no final or partial file in a stable directory', async () => {
  const f = await fixture(),
    guard = await capturePublicationDirectory(f.root, f.parent),
    controller = new AbortController()
  await guard.prepare()
  await assert.rejects(
    atomicNewFile(
      f.target,
      async (handle) => {
        await handle.writeFile('partial')
        controller.abort()
      },
      controller.signal,
      () => guard.assertUnchanged()
    )
  )
  assert.deepEqual(await fs.readdir(f.parent), [])
})
