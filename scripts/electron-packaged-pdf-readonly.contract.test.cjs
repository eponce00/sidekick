const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { execFileSync } = require('node:child_process')
const { EventEmitter } = require('node:events')
const {
  configuration,
  removeOwned,
  verifySnapshot
} = require('./electron-packaged-pdf-readonly.cjs')
const {
  validateSource,
  withDeadline,
  closeOwned,
  failureReport,
  SmokeFailure
} = require('./electron-packaged-pdf-readonly.cjs')

test('rejects oversized, empty, nonregular and invalid sizes before allocating PDF bytes', () => {
  validateSource({ isFile: () => true, size: 64 * 1024 * 1024 })
  for (const size of [0, -1, Infinity, NaN, 1.5, 64 * 1024 * 1024 + 1])
    assert.throws(() => validateSource({ isFile: () => true, size }))
  assert.throws(() => validateSource({ isFile: () => false, size: 1 }))
})
test('deadline bounds a hanging navigation and permits completed operations', async () => {
  assert.equal(await withDeadline(() => Promise.resolve(42), 100), 42)
  await assert.rejects(
    withDeadline(() => new Promise(() => {}), 5),
    (error) => error.category === 'timeout'
  )
})
test('cleanup terminates only the owned child after close hangs, then confirms exit', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null })
  let killed
  await closeOwned(
    { process: () => child, close: () => new Promise(() => {}) },
    5,
    async (owned) => {
      killed = owned
      owned.signalCode = 'SIGKILL'
      owned.emit('exit')
    }
  )
  assert.equal(killed, child)
  await assert.rejects(closeOwned({ process: () => null, close: async () => {} }, 5))
})
test('safe failure report preserves primary stage and cleanup categories without raw exception text', () => {
  const primary = new SmokeFailure('navigation', 'timeout')
  primary.cleanup = ['app_close', 'profile_retained']
  assert.equal(failureReport(primary).failureStage, 'navigation')
  assert.deepEqual(failureReport(primary).cleanupFailures, ['app_close', 'profile_retained'])
  assert.equal(failureReport(primary).renderingMode, 'software_disable_gpu')
  assert.ok(
    !JSON.stringify(failureReport(new Error('PRIVATE_DOCUMENT_PATH_TEXT'))).includes('PRIVATE')
  )
})

test('CLI defaults to a non-launching skip without opt-in', () => {
  const output = execFileSync(
    process.execPath,
    [join(__dirname, 'electron-packaged-pdf-readonly.cjs')],
    {
      env: { ...process.env, SIDEKICK_PACKAGED_PDF_RUN: '' },
      encoding: 'utf8'
    }
  )
  assert.match(output, /^SKIP:/)
})

test('requires explicit opt-in and caller-selected absolute inputs', () => {
  assert.equal(configuration({}), null)
  assert.throws(() => configuration({ SIDEKICK_PACKAGED_PDF_RUN: '1' }))
  const config = configuration({
    SIDEKICK_PACKAGED_PDF_RUN: '1',
    SIDEKICK_E2E_EXECUTABLE: join(tmpdir(), 'app.exe'),
    SIDEKICK_E2E_PDF: join(tmpdir(), 'caller.pdf')
  })
  assert.equal(config.keep, false)
  assert.equal(config.expectedPages, undefined)
  assert.throws(() =>
    configuration({
      SIDEKICK_PACKAGED_PDF_RUN: '1',
      SIDEKICK_E2E_EXECUTABLE: 'relative.exe',
      SIDEKICK_E2E_PDF: 'relative.pdf'
    })
  )
})
test('cleanup rejects broad or non-fixture paths and removes only dedicated temporary directories', () => {
  assert.throws(() => removeOwned(tmpdir()))
  assert.throws(() => removeOwned(join(tmpdir(), 'ordinary-profile')))
  assert.throws(() => removeOwned(join(tmpdir(), 'sidekick-e2e-pdf-parent', 'child')))
  const fixture = mkdtempSync(join(tmpdir(), 'sidekick-e2e-pdf-contract-'))
  removeOwned(fixture)
  assert.equal(existsSync(fixture), false)
})
test('requires Ready, every loaded native page image, no saved copy, and expected page count', () => {
  const valid = {
    ready: true,
    error: false,
    saved: false,
    pages: 1,
    images: [{ loaded: true, width: 100, height: 200 }]
  }
  verifySnapshot(valid, 1)
  for (const patch of [
    { ready: false },
    { error: true },
    { saved: true },
    { pages: 2 },
    { images: [] },
    { images: [{ loaded: false, width: 0, height: 0 }] }
  ])
    assert.throws(() => verifySnapshot({ ...valid, ...patch }, 1))
  assert.throws(() => verifySnapshot(valid, 2))
})
