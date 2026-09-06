// Opt-in investigation, not a release qualification or production dispatch change.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, relative } = require('node:path')

async function main() {
  if (process.env.SIDEKICK_NATIVE_INPUT_PROTOTYPE !== '1') {
    console.log('Set SIDEKICK_NATIVE_INPUT_PROTOTYPE=1 to run this bounded GUI investigation.')
    return
  }
  assert.equal(process.platform, 'win32', 'This prototype uses Windows Control shortcuts')
  const profile = mkdtempSync(join(tmpdir(), 'sidekick-input-prototype-'))
  let primaryError
  try {
    const env = { ...process.env, SIDEKICK_NATIVE_INPUT_PROFILE: profile }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(
      require('electron'),
      [join(__dirname, 'native-input-prototype.entry.cjs')],
      {
        cwd: resolve(__dirname, '..'),
        env,
        windowsHide: true,
        stdio: ['ignore', 'inherit', 'inherit']
      }
    )
    const timer = setTimeout(() => child.kill(), 120000)
    try {
      const code = await new Promise((done, reject) => {
        child.once('error', reject)
        child.once('exit', done)
      })
      assert.equal(code, 0, 'Native input prototype did not complete')
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    const inside = relative(tmpdir(), profile)
    assert.ok(inside.startsWith('sidekick-input-prototype-') && !inside.includes('..'))
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      if (!primaryError) throw error
      console.error('Prototype cleanup also failed')
    }
  }
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
