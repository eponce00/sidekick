// Viewer integration only: synthetic DOM events, not native input/model qualification.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createHash } = require('node:crypto')
const { tmpdir } = require('node:os')
const { join, resolve, isAbsolute } = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const {
  withDeadline,
  closeOwned,
  removeOwned,
  validateSource
} = require('./electron-packaged-pdf-readonly.cjs')

function configuration(env) {
  if (env.SIDEKICK_PACKAGED_PDF_SAVE_RUN !== '1') return null
  for (const name of ['SIDEKICK_E2E_EXECUTABLE', 'SIDEKICK_PDF_LIB_PACKAGE'])
    assert.ok(env[name] && isAbsolute(env[name]))
  if (env.SIDEKICK_PDF_SAVE_CAPTURES === '1')
    assert.ok(env.SIDEKICK_PDF_SAVE_POPPLER && isAbsolute(env.SIDEKICK_PDF_SAVE_POPPLER))
  return {
    executable: env.SIDEKICK_E2E_EXECUTABLE,
    pdfLib: env.SIDEKICK_PDF_LIB_PACKAGE,
    captures: env.SIDEKICK_PDF_SAVE_CAPTURES === '1',
    poppler: env.SIDEKICK_PDF_SAVE_POPPLER
  }
}
function readOwnedPdf(path) {
  validateSource(fs.lstatSync(path))
  const fd = fs.openSync(path, 'r')
  try {
    const stat = fs.fstatSync(fd)
    validateSource(stat)
    const bytes = Buffer.alloc(stat.size + 1)
    let total = 0
    while (total < bytes.length) {
      const count = fs.readSync(fd, bytes, total, bytes.length - total, null)
      if (!count) break
      total += count
    }
    assert.equal(total, stat.size)
    return bytes.subarray(0, total)
  } finally {
    fs.closeSync(fd)
  }
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function createFixture(PDFDocument) {
  const pdf = await PDFDocument.create()
  const first = pdf.addPage([400, 400]),
    second = pdf.addPage([400, 400])
  const form = pdf.getForm()
  form.createTextField('first_text').addToPage(first, { x: 30, y: 300, width: 220, height: 25 })
  form.createTextField('second_text').addToPage(second, { x: 30, y: 300, width: 220, height: 25 })
  const choice = form.createDropdown('choice')
  choice.setOptions(['Normal', 'High'])
  choice.select('Normal')
  choice.addToPage(second, { x: 30, y: 240, width: 220, height: 25 })
  form.createCheckBox('check').addToPage(first, { x: 30, y: 230, width: 20, height: 20 })
  const radio = form.createRadioGroup('radio')
  radio.addOptionToPage('First', first, { x: 30, y: 160, width: 20, height: 20 })
  radio.addOptionToPage('Second', second, { x: 30, y: 160, width: 20, height: 20 })
  radio.select('First')
  return Buffer.from(await pdf.save())
}
function assertSnapshot(snapshot, round) {
  assert.equal(snapshot.saved, true)
  assert.equal(snapshot.scope, 'acroform')
  assert.equal(snapshot.error, false)
  assert.equal(snapshot.pages, 2)
  assert.equal(snapshot.round, round)
}
async function verifyCopy(PDFDocument, bytes, round) {
  const pdf = await PDFDocument.load(bytes)
  assert.equal(pdf.getPageCount(), 2)
  const form = pdf.getForm()
  assert.equal(form.getTextField('first_text').getText(), `First ${round}`)
  assert.equal(form.getTextField('second_text').getText(), `Second ${round}`)
  assert.deepEqual(form.getDropdown('choice').getSelected(), [round === 1 ? 'High' : 'Normal'])
  assert.equal(form.getCheckBox('check').isChecked(), round === 1)
  assert.equal(form.getRadioGroup('radio').getSelected(), round === 1 ? 'Second' : 'First')
}
async function viewer(application, source) {
  return application.evaluate(async ({ webContents }, source) => {
    const matches = webContents
      .getAllWebContents()
      .filter((w) => w.getURL().startsWith('sidekick-pdf:'))
    if (matches.length !== 1) return null
    return matches[0].executeJavaScript(source)
  }, source)
}
const snapshotScript = `({ready:document.documentElement.dataset.sidekickPdfReady==='true',error:document.documentElement.dataset.sidekickPdfError==='true',saved:document.documentElement.dataset.sidekickPdfSaved==='true',scope:document.documentElement.dataset.sidekickPdfVerification,output:document.documentElement.dataset.sidekickPdfOutput,pages:document.querySelectorAll('.page').length,round:Number(document.documentElement.dataset.fixtureRound||0),failed:document.querySelector('#status')?.dataset.kind==='error'})`
function editScript(round) {
  assert.ok(round === 1 || round === 2)
  return `(()=>{
    const round=${round};
    const get=name=>Array.from(document.querySelectorAll('.pdf-field')).find(e=>e.dataset.fieldName===name);
    for(const name of ['first_text','second_text','choice','check']) { const e=get(name);if(!e||e.disabled)throw new Error('Fixture control unavailable'); }
    for(const [name,value] of [['first_text','First '+round],['second_text','Second '+round],['choice',round===1?'High':'Normal']]){
      const e=get(name);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));
    }
    const check=get('check');check.checked=round===1;check.dispatchEvent(new Event('change',{bubbles:true}));
    const radios=Array.from(document.querySelectorAll('input.pdf-field[type="radio"]')).filter(e=>e.name==='radio');
    if(radios.length!==2||radios.some(e=>e.disabled))throw new Error('Fixture radios unavailable');
    const radio=radios[round===1?1:0];radio.checked=true;radio.dispatchEvent(new Event('change',{bubbles:true}));
    if(document.documentElement.dataset.sidekickPdfSaved!=='false')throw new Error('Fixture edits not dirty');
    document.documentElement.dataset.fixtureRound=String(round);
    const save=document.querySelector('#save');if(!save||save.disabled)throw new Error('Fixture save unavailable');save.click();
    return true;
  })()`
}
async function run(config) {
  assert.ok(fs.statSync(config.executable).isFile())
  const { PDFDocument } = require(config.pdfLib)
  const profile = fs.mkdtempSync(join(tmpdir(), 'sidekick-e2e-pdf-save-'))
  const workspace = join(profile, 'workspace'),
    source = join(workspace, 'fixture.pdf')
  let captures
  let renderPromise
  let application,
    launchPromise,
    primary,
    stage = 'fixture_setup',
    expired = false,
    sourceHash
  const active = () => {
    if (expired) throw new Error('Deadline expired')
  }
  const start = Date.now()
  try {
    return await withDeadline(async () => {
      const bytes = await createFixture(PDFDocument)
      active()
      fs.mkdirSync(workspace)
      fs.writeFileSync(source, bytes, { flag: 'wx' })
      sourceHash = digest(bytes)
      stage = 'launch'
      const { _electron } = require('playwright')
      const env = { ...process.env, NODE_ENV: 'production', SIDEKICK_E2E_USER_DATA_DIR: profile }
      delete env.ELECTRON_RUN_AS_NODE
      launchPromise = _electron.launch({
        executablePath: config.executable,
        args: ['--disable-gpu', '--sidekick-packaged-smoke-test', '--sidekick-e2e'],
        env,
        timeout: 30000
      })
      application = await launchPromise
      active()
      assert.equal(await application.evaluate(({ app }) => app.isPackaged), true)
      active()
      assert.equal(
        resolve(await application.evaluate(({ app }) => app.getPath('userData'))),
        resolve(profile)
      )
      active()
      const page = await application.firstWindow()
      active()
      await page.waitForFunction(() => Boolean(window.api?.agentRuns))
      active()
      stage = 'navigation'
      await page.evaluate(
        async ({ workspace, url }) => {
          const project = await window.api.projects.create(workspace, 'Synthetic PDF save fixture')
          const conversation = await window.api.conversations.create(
            'Synthetic PDF save fixture',
            project.id
          )
          await window.api.agentRuns.browserWorkspace({
            conversationId: conversation.id,
            action: 'url',
            url
          })
        },
        { workspace, url: pathToFileURL(source).href }
      )
      active()
      async function waitFor(predicate) {
        while (true) {
          active()
          const state = await viewer(application, snapshotScript)
          active()
          if (state?.error || state?.failed) throw new Error('Viewer failed')
          if (predicate(state)) return state
          await new Promise((done) => setTimeout(done, 100))
        }
      }
      stage = 'viewer_ready'
      const ready = await waitFor((s) => s?.ready)
      assert.equal(ready.pages, 2)
      for (const round of [1, 2]) {
        stage = `save_${round}`
        active()
        assert.equal(await viewer(application, editScript(round)), true)
        active()
        const state = await waitFor((s) => s?.saved && s.round === round)
        assertSnapshot(state, round)
        const expected = join(
          workspace,
          round === 1 ? 'fixture-filled.pdf' : 'fixture-filled-2.pdf'
        )
        assert.equal(resolve(state.output), resolve(expected))
        active()
        await verifyCopy(PDFDocument, readOwnedPdf(expected), round)
        active()
        assert.equal(digest(readOwnedPdf(source)), sourceHash)
      }
      if (config.captures) {
        stage = 'saved_render'
        captures = fs.mkdtempSync(join(tmpdir(), 'sidekick-e2e-pdf-save-captures-'))
        for (const round of [1, 2]) {
          const name = round === 1 ? 'fixture-filled.pdf' : 'fixture-filled-2.pdf'
          const copy = join(captures, `save-${round}.pdf`)
          active()
          fs.writeFileSync(copy, readOwnedPdf(join(workspace, name)), { flag: 'wx' })
          renderPromise = promisify(execFile)(
            config.poppler,
            ['-png', '-r', '100', copy, join(captures, `save-${round}-page`)],
            { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }
          )
          await renderPromise
          renderPromise = undefined
          active()
          for (const page of [1, 2])
            assert.ok(fs.statSync(join(captures, `save-${round}-page-${page}.png`)).size > 0)
        }
      }
      stage = 'source_verification'
      assert.equal(digest(readOwnedPdf(source)), sourceHash)
      return {
        schemaVersion: 1,
        passed: true,
        qualification: 'packaged_viewer_DOM_events_not_native_input',
        renderingMode: 'software_disable_gpu',
        pages: 2,
        saves: 2,
        fieldsPerSave: 5,
        scope: 'acroform',
        sourceUnchanged: true,
        ...(captures ? { artifactDirectory: captures } : {}),
        elapsedMs: Date.now() - start
      }
    }, 90000)
  } catch {
    expired = true
    primary = { schemaVersion: 1, passed: false, failureStage: stage, cleanupFailures: [] }
    throw primary
  } finally {
    expired = true
    const failures = []
    let rendererClosed = !renderPromise
    try {
      if (renderPromise) await withDeadline(() => renderPromise, 17000)
      rendererClosed = true
    } catch {
      failures.push('render_cleanup')
    }
    let closed = !launchPromise
    try {
      if (!application && launchPromise)
        application = await withDeadline(() => launchPromise, 35000)
      if (application) await closeOwned(application)
      closed = true
    } catch {
      failures.push('app_close')
      if (!application && launchPromise)
        launchPromise.then((owned) => closeOwned(owned)).catch(() => {})
    }
    try {
      if (sourceHash) assert.equal(digest(readOwnedPdf(source)), sourceHash)
    } catch {
      failures.push('source_preservation')
    }
    try {
      if (closed) removeOwned(profile)
      else failures.push('profile_retained')
    } catch {
      failures.push('profile_cleanup')
    }
    if (captures && (primary || failures.length)) {
      try {
        if (rendererClosed) removeOwned(captures)
        else failures.push('captures_retained')
      } catch {
        failures.push('capture_cleanup')
      }
    }
    if (failures.length) {
      if (primary) primary.cleanupFailures = failures
      else
        throw {
          schemaVersion: 1,
          passed: false,
          failureStage: 'cleanup',
          cleanupFailures: failures
        }
    }
  }
}
function safeFailure(error) {
  const stages = [
    'fixture_setup',
    'launch',
    'navigation',
    'viewer_ready',
    'save_1',
    'save_2',
    'source_verification',
    'saved_render',
    'cleanup'
  ]
  return {
    schemaVersion: 1,
    passed: false,
    failureStage: stages.includes(error?.failureStage) ? error.failureStage : 'configuration',
    cleanupFailures: Array.isArray(error?.cleanupFailures)
      ? error.cleanupFailures.filter((x) =>
          [
            'app_close',
            'source_preservation',
            'profile_retained',
            'profile_cleanup',
            'capture_cleanup',
            'render_cleanup',
            'captures_retained'
          ].includes(x)
        )
      : []
  }
}
module.exports = {
  configuration,
  createFixture,
  verifyCopy,
  assertSnapshot,
  editScript,
  safeFailure,
  run
}
if (require.main === module)
  Promise.resolve()
    .then(() => {
      const config = configuration(process.env)
      if (!config) {
        console.log('SKIP: explicit SIDEKICK_PACKAGED_PDF_SAVE_RUN=1 required')
        return null
      }
      return run(config)
    })
    .then((report) => {
      if (report) console.log(JSON.stringify(report))
    })
    .catch((error) => {
      console.error(JSON.stringify(safeFailure(error)))
      process.exitCode = 1
    })
