const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const {
  configuration,
  createFixture,
  verifyCopy,
  assertSnapshot,
  editScript,
  safeFailure
} = require('./electron-packaged-pdf-save.cjs')

test('defaults to a no-launch opt-in skip', () => {
  const output = execFileSync(
    process.execPath,
    [join(__dirname, 'electron-packaged-pdf-save.cjs')],
    { env: { ...process.env, SIDEKICK_PACKAGED_PDF_SAVE_RUN: '' }, encoding: 'utf8' }
  )
  assert.match(output, /^SKIP:/)
})
test('requires explicit absolute executable and existing optional dependency location', () => {
  assert.equal(configuration({}), null)
  assert.throws(() => configuration({ SIDEKICK_PACKAGED_PDF_SAVE_RUN: '1' }))
  assert.throws(() =>
    configuration({
      SIDEKICK_PACKAGED_PDF_SAVE_RUN: '1',
      SIDEKICK_E2E_EXECUTABLE: 'relative.exe',
      SIDEKICK_PDF_LIB_PACKAGE: 'relative'
    })
  )
})
test('scope and round assertions cannot accept stale saves', () => {
  const valid = { saved: true, scope: 'acroform', error: false, pages: 2, round: 1 }
  assertSnapshot(valid, 1)
  for (const change of [
    { saved: false },
    { scope: undefined },
    { scope: 'acroform-xfa-unverified' },
    { error: true },
    { pages: 1 },
    { round: 0 }
  ])
    assert.throws(() => assertSnapshot({ ...valid, ...change }, 1))
})
test('does not disclose raw failure messages or uncontrolled cleanup values', () => {
  const report = safeFailure({
    failureStage: 'private path',
    cleanupFailures: ['app_close', 'private value'],
    message: 'private'
  })
  assert.equal(JSON.stringify(report).includes('private'), false)
  assert.deepEqual(report.cleanupFailures, ['app_close'])
})
test('DOM driver only accepts the two intended rounds', () => {
  assert.throws(() => editScript(0))
  assert.throws(() => editScript(3))
  assert.match(editScript(1), /save\.click\(\)/)
  assert.equal(editScript(1).includes('sendInputEvent'), false)
})
const packagePath = process.env.SIDEKICK_PDF_LIB_PACKAGE
test(
  'independent oracle checks all fields in both copies and rejects unchanged source',
  { skip: !packagePath },
  async () => {
    const { PDFDocument } = require(packagePath)
    const original = await createFixture(PDFDocument)
    const retained = Buffer.from(original)
    await assert.rejects(() => verifyCopy(PDFDocument, original, 1))
    for (const round of [1, 2]) {
      const pdf = await PDFDocument.load(original)
      const form = pdf.getForm()
      form.getTextField('first_text').setText(`First ${round}`)
      form.getTextField('second_text').setText(`Second ${round}`)
      form.getDropdown('choice').select(round === 1 ? 'High' : 'Normal')
      if (round === 1) form.getCheckBox('check').check()
      else form.getCheckBox('check').uncheck()
      form.getRadioGroup('radio').select(round === 1 ? 'Second' : 'First')
      await verifyCopy(PDFDocument, await pdf.save(), round)
      await assert.rejects(() => verifyCopy(PDFDocument, awaitableInvalidBytes(), round))
    }
    assert.deepEqual(original, retained)
  }
)
function awaitableInvalidBytes() {
  return new Uint8Array([1, 2, 3])
}
