// Caller-owned PDF only; no fixture downloads, document edits, save actions, or inference.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createHash } = require('node:crypto')
const { tmpdir } = require('node:os')
const { join, resolve, relative, isAbsolute } = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const MAX_PDF_BYTES = 64 * 1024 * 1024
class SmokeFailure extends Error {
  constructor(stage, cause) {
    super('Packaged PDF smoke failed')
    this.stage = stage
    this.category = cause
    this.cleanup = []
  }
}
function validateSource(metadata) {
  assert.ok(
    metadata.isFile() &&
      Number.isSafeInteger(metadata.size) &&
      metadata.size > 0 &&
      metadata.size <= MAX_PDF_BYTES
  )
}
async function withDeadline(operation, milliseconds) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SmokeFailure('deadline', 'timeout')), milliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function closeOwned(
  application,
  milliseconds = 10000,
  terminate = async (child) => {
    if (process.platform === 'win32')
      await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000
      })
    else child.kill('SIGKILL')
  }
) {
  const child = application.process()
  try {
    await withDeadline(() => application.close(), milliseconds)
  } catch {
    if (child && child.exitCode === null && child.signalCode === null) {
      assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
      await terminate(child)
    }
  }
  assert.ok(child, 'Owned child process required')
  if (child.exitCode === null && child.signalCode === null)
    await withDeadline(() => new Promise((done) => child.once('exit', done)), milliseconds)
}
function failureReport(error) {
  // Only locally created fixed vocabulary; never serialize arbitrary exception messages.
  const safe =
    error instanceof SmokeFailure ? error : new SmokeFailure('configuration', 'invalid_input')
  const stages = [
    'configuration',
    'fixture_setup',
    'launch',
    'preload',
    'navigation',
    'viewer_ready',
    'page_capture',
    'source_verification',
    'cleanup'
  ]
  const causes = ['invalid_input', 'timeout', 'check_failed', 'cleanup_failed']
  const cleanup = [
    'app_close',
    'source_preservation',
    'profile_retained',
    'profile_cleanup',
    'capture_cleanup'
  ]
  return {
    schemaVersion: 1,
    passed: false,
    renderingMode: 'software_disable_gpu',
    failureStage: stages.includes(safe.stage) ? safe.stage : 'configuration',
    cause: causes.includes(safe.category) ? safe.category : 'check_failed',
    cleanupFailures: safe.cleanup.filter((value) => cleanup.includes(value))
  }
}

function configuration(env) {
  if (env.SIDEKICK_PACKAGED_PDF_RUN !== '1') return null
  for (const key of ['SIDEKICK_E2E_EXECUTABLE', 'SIDEKICK_E2E_PDF'])
    assert.ok(env[key] && isAbsolute(env[key]), `Explicit absolute ${key} required`)
  const expectedSha = env.SIDEKICK_E2E_PDF_SHA256
  if (expectedSha) assert.match(expectedSha, /^[a-fA-F0-9]{64}$/)
  const expectedPages = env.SIDEKICK_E2E_PDF_PAGES ? Number(env.SIDEKICK_E2E_PDF_PAGES) : undefined
  if (expectedPages !== undefined)
    assert.ok(Number.isSafeInteger(expectedPages) && expectedPages > 0)
  return {
    executable: env.SIDEKICK_E2E_EXECUTABLE,
    source: env.SIDEKICK_E2E_PDF,
    expectedSha: expectedSha?.toLowerCase(),
    expectedPages,
    keep: env.SIDEKICK_E2E_PDF_KEEP === '1'
  }
}
function removeOwned(directory) {
  const child = relative(resolve(tmpdir()), resolve(directory))
  assert.ok(
    child &&
      !child.startsWith('..') &&
      !isAbsolute(child) &&
      !/[\\/]/.test(child) &&
      child.startsWith('sidekick-e2e-pdf-')
  )
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
function readSource(path) {
  validateSource(fs.lstatSync(path))
  const fd = fs.openSync(path, 'r')
  try {
    const stat = fs.fstatSync(fd)
    validateSource(stat)
    const bytes = Buffer.alloc(stat.size + 1)
    let count = 0,
      read
    while (
      count < bytes.length &&
      (read = fs.readSync(fd, bytes, count, bytes.length - count, null)) > 0
    )
      count += read
    assert.equal(count, stat.size, 'PDF size changed during bounded read')
    return bytes.subarray(0, count)
  } finally {
    fs.closeSync(fd)
  }
}
const digest = (path) => createHash('sha256').update(readSource(path)).digest('hex')
function verifySnapshot(snapshot, expectedPages) {
  assert.equal(snapshot.ready, true)
  assert.equal(snapshot.error, false)
  assert.equal(snapshot.saved, false)
  assert.ok(snapshot.pages > 0)
  assert.equal(snapshot.images.length, snapshot.pages)
  if (expectedPages !== undefined) assert.equal(snapshot.pages, expectedPages)
  for (const page of snapshot.images) {
    assert.equal(page.loaded, true)
    assert.ok(page.width > 0 && page.height > 0)
  }
}
async function run(config) {
  const sourceBytes = readSource(config.source)
  assert.ok(fs.statSync(config.executable).isFile())
  const sourceDigest = createHash('sha256').update(sourceBytes).digest('hex')
  if (config.expectedSha) assert.equal(sourceDigest, config.expectedSha)
  const profile = fs.mkdtempSync(join(tmpdir(), 'sidekick-e2e-pdf-profile-'))
  const workspace = join(profile, 'workspace')
  const copy = join(workspace, 'input.pdf')
  let application, captures, primaryError, launchPromise
  let expired = false
  const requireActive = () => {
    if (expired) throw new SmokeFailure('deadline', 'timeout')
  }
  let stage = 'fixture_setup'
  try {
    return await withDeadline(async () => {
      fs.mkdirSync(workspace)
      fs.writeFileSync(copy, sourceBytes, { flag: 'wx' })
      const { _electron } = require('playwright')
      stage = 'launch'
      launchPromise = _electron.launch({
        executablePath: config.executable,
        args: ['--disable-gpu', '--sidekick-packaged-smoke-test', '--sidekick-e2e'],
        env: { ...process.env, NODE_ENV: 'production', SIDEKICK_E2E_USER_DATA_DIR: profile },
        timeout: 30000
      })
      application = await launchPromise
      requireActive()
      stage = 'preload'
      assert.equal(await application.evaluate(({ app }) => app.isPackaged), true)
      assert.equal(
        resolve(await application.evaluate(({ app }) => app.getPath('userData'))),
        resolve(profile)
      )
      const page = await application.firstWindow()
      await page.waitForFunction(() => Boolean(window.api?.agentRuns))
      stage = 'navigation'
      await page.evaluate(
        async ({ workspace, url }) => {
          const project = await window.api.projects.create(workspace, 'Read-only PDF fixture')
          const conversation = await window.api.conversations.create(
            'Read-only PDF fixture',
            project.id
          )
          await window.api.agentRuns.browserWorkspace({
            conversationId: conversation.id,
            action: 'url',
            url
          })
        },
        { workspace, url: pathToFileURL(copy).href }
      )
      let snapshot
      stage = 'viewer_ready'
      const deadline = Date.now() + 45000
      do {
        requireActive()
        snapshot = await application.evaluate(async ({ webContents }) => {
          const viewer = webContents
            .getAllWebContents()
            .find((content) => content.getURL().startsWith('sidekick-pdf:'))
          if (!viewer) return null
          return viewer.executeJavaScript(
            `({ready:document.documentElement.dataset.sidekickPdfReady==='true',error:document.documentElement.dataset.sidekickPdfError==='true',saved:document.documentElement.dataset.sidekickPdfSaved==='true',pages:parseInt(document.querySelector('#document-meta')?.textContent||'0',10)||0,images:Array.from(document.querySelectorAll('.page > img'),image=>({loaded:image.complete&&image.naturalWidth>0,width:image.naturalWidth,height:image.naturalHeight}))})`
          )
        })
        if (snapshot?.ready || snapshot?.error) break
        await new Promise((done) => setTimeout(done, 100))
      } while (Date.now() < deadline)
      assert.ok(snapshot, 'PDF viewer must exist')
      verifySnapshot(snapshot, config.expectedPages)
      if (config.keep) {
        requireActive()
        stage = 'page_capture'
        captures = fs.mkdtempSync(join(tmpdir(), 'sidekick-e2e-pdf-captures-'))
        for (let index = 0; index < snapshot.pages; index++) {
          const bytes = await application.evaluate(async ({ webContents }, index) => {
            const viewer = webContents
              .getAllWebContents()
              .find((content) => content.getURL().startsWith('sidekick-pdf:'))
            return viewer.executeJavaScript(
              `(async()=>Array.from(new Uint8Array(await (await fetch(document.querySelectorAll('.page > img')[${index}].src)).arrayBuffer())))()`
            )
          }, index)
          requireActive()
          fs.writeFileSync(join(captures, `page-${index + 1}.png`), Buffer.from(bytes), {
            flag: 'wx'
          })
        }
      }
      stage = 'source_verification'
      requireActive()
      assert.equal(digest(copy), sourceDigest)
      assert.equal(digest(config.source), sourceDigest)
      return {
        schemaVersion: 1,
        renderingMode: 'software_disable_gpu',
        pages: snapshot.pages,
        images: snapshot.images,
        sourceSha256: sourceDigest,
        sourceUnchanged: true,
        ...(captures ? { artifactDirectory: captures } : {})
      }
    }, 90000)
  } catch (error) {
    expired = true
    primaryError = new SmokeFailure(
      stage,
      error instanceof SmokeFailure ? 'timeout' : 'check_failed'
    )
    throw primaryError
  } finally {
    const failures = []
    let closed = !launchPromise
    try {
      if (!application && launchPromise)
        application = await withDeadline(() => launchPromise, 35000)
      if (application) await closeOwned(application)
      closed = true
    } catch {
      // A late launch result is still ours; close it, but retain its profile when
      // this bounded cleanup could not confirm exit. Never discover/kill app names.
      if (!application && launchPromise)
        launchPromise.then((owned) => closeOwned(owned)).catch(() => {})
      failures.push('app_close')
    }
    try {
      assert.equal(digest(config.source), sourceDigest)
    } catch {
      failures.push('source_preservation')
    }
    try {
      if (closed) removeOwned(profile)
      else failures.push('profile_retained')
    } catch {
      failures.push('profile_cleanup')
    }
    try {
      if (captures && primaryError) removeOwned(captures)
    } catch {
      failures.push('capture_cleanup')
    }
    if (failures.length) {
      if (primaryError) primaryError.cleanup = failures
      else {
        const failure = new SmokeFailure('cleanup', 'cleanup_failed')
        failure.cleanup = failures
        throw failure
      }
    }
  }
}
module.exports = {
  configuration,
  removeOwned,
  verifySnapshot,
  run,
  validateSource,
  withDeadline,
  closeOwned,
  failureReport,
  SmokeFailure
}
if (require.main === module) {
  Promise.resolve()
    .then(() => {
      const config = configuration(process.env)
      if (!config) {
        console.log('SKIP: explicit SIDEKICK_PACKAGED_PDF_RUN=1 required')
        return null
      }
      return run(config)
    })
    .then((report) => {
      if (report) console.log(JSON.stringify(report))
    })
    .catch((error) => {
      // Do not expose renderer errors containing paths or document text.
      console.error(JSON.stringify(failureReport(error)))
      process.exitCode = 1
    })
}
