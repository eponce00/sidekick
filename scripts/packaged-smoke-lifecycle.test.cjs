const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const YAML = require('yaml')
const { observeStartup, smokeDuration } = require('./packaged-smoke-lifecycle.cjs')

test('smoke duration rejects invalid, zero, and unbounded observation windows', () => {
  assert.equal(smokeDuration(), 8000)
  assert.equal(smokeDuration('120'), 120000)
  for (const value of ['', '0', '-1', '1.5', '8junk', 'NaN', '121']) {
    assert.throws(() => smokeDuration(value), /integer from 1 to 120/)
  }
})

test('startup rejects an actual missing executable instead of an unhandled error', async () => {
  const child = spawn('sidekick-nonexistent-smoke-executable-8e840e', [], { stdio: 'ignore' })
  await assert.rejects(observeStartup(child, 5000), /failed to start/)
  assert.equal(child.listenerCount('exit'), 0)
})

test('startup rejects even a clean early exit', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await assert.rejects(observeStartup(child, 5000), /code 0/)
})

test('startup rejects signal termination even with a null exit code', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
  const observed = observeStartup(child, 5000)
  child.emit('exit', null, 'SIGSEGV')
  await assert.rejects(observed, /signal SIGSEGV/)
  assert.equal(child.listenerCount('error'), 0)
})

test('startup rejects a process that already terminated', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: 'SIGKILL' })
  await assert.rejects(observeStartup(child, 5000), /signal SIGKILL/)
})

test('successful observation removes lifecycle listeners', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
  await observeStartup(child, 1)
  assert.equal(child.listenerCount('exit'), 0)
  assert.equal(child.listenerCount('error'), 0)
})

test('CI and release journeys launch packaged binaries on every supported platform', () => {
  const workflow = (name) =>
    YAML.parse(readFileSync(join(__dirname, '..', '.github', 'workflows', name), 'utf8'))
  const ci = workflow('ci.yml').jobs.validate
  const expected = {
    windows: 'dist/win-unpacked/SideKick.exe',
    macos: 'dist/mac-arm64/SideKick.app/Contents/MacOS/SideKick',
    linux: 'dist/linux-unpacked/io.github.eponce00.sidekick'
  }
  for (const entry of ci.strategy.matrix.include) {
    assert.equal(entry.executable, expected[entry.smoke])
  }
  const ciJourneys = ci.steps.filter((step) => step.run?.includes('test:e2e:runtime'))
  const fixtureSteps = ci.steps.filter((step) => step.run?.includes('test:native-browser-fixtures'))
  assert.equal(fixtureSteps.length, 2, 'CI must run no-model PDF/form fixtures on all platforms')
  assert.ok(fixtureSteps.some((step) => step.run.startsWith('xvfb-run')))
  assert.equal(ciJourneys.length, 2)
  for (const step of ciJourneys) {
    assert.equal(step.env.SIDEKICK_E2E_EXECUTABLE, '${{ matrix.executable }}')
  }
  const release = workflow('release.yml')
  for (const [platform, executable] of Object.entries(expected)) {
    const steps = release.jobs[platform].steps
    const journey = steps.find((step) => step.run?.includes('test:e2e:runtime'))
    assert.equal(journey.env.SIDEKICK_E2E_EXECUTABLE, executable)
    assert.ok(
      steps.some((step) => step.run?.includes('test:native-browser-fixtures')),
      `${platform} release must retain the native PDF/form fixture gate`
    )
  }
  const macSmoke = release.jobs.macos.steps.find(
    (step) => step.run === 'npm run smoke:packaged:macos'
  )
  assert.notEqual(macSmoke.env?.SIDEKICK_ALLOW_UNSIGNED_SMOKE, 'true')
})
