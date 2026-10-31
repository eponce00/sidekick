const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const YAML = require('yaml')

const release = YAML.parse(
  readFileSync(join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8')
)
const { jobs } = release
const gates = ['checks', 'tests', 'windows', 'macos', 'linux']
const runs = (job) => job.steps.filter((step) => step.run).map((step) => step.run)

test('a release runs every check, the suite on every platform, and each packaged build', () => {
  for (const command of [
    'npm run typecheck',
    'npm run lint',
    'npm run docs:check',
    'npm run test:docs'
  ]) {
    assert.ok(runs(jobs.checks).includes(command), `checks must run ${command}`)
  }

  // Every shard of every platform's suite runs.
  const shards = {}
  for (const entry of jobs.tests.strategy.matrix.include) {
    ;(shards[entry.os] ??= []).push(entry.shard)
  }
  assert.deepEqual(Object.keys(shards).sort(), ['macos-15', 'ubuntu-22.04', 'windows-latest'])
  for (const list of Object.values(shards)) {
    const total = Number(list[0].split('/')[1])
    assert.deepEqual(
      list.sort(),
      Array.from({ length: total }, (_, index) => `${index + 1}/${total}`)
    )
  }
  assert.ok(runs(jobs.tests).includes('npm test -- --shard=${{ matrix.shard }}'))

  const builds = { windows: 'build:win', macos: 'build:mac', linux: 'build:linux' }
  for (const [platform, build] of Object.entries(builds)) {
    const commands = runs(jobs[platform])
    assert.ok(commands.includes('npm run test:release'), `${platform} must test release tooling`)
    assert.ok(commands.includes(`npm run ${build}`), `${platform} must build with ${build}`)
  }
})

test('release jobs install from a clean npm ci and restore no installed dependencies', () => {
  for (const [name, job] of Object.entries(jobs)) {
    for (const step of job.steps) {
      assert.ok(!step.uses?.startsWith('actions/cache'), `${name} must not restore a cache`)
      assert.ok(!step.uses?.startsWith('./'), `${name} must not use a local action`)
    }
  }
  for (const name of gates) {
    assert.ok(runs(jobs[name]).includes('npm ci'), `${name} must install with npm ci`)
  }
  // The jobs holding signing and publishing credentials run no third-party packages.
  for (const name of ['sign-windows', 'publish']) {
    assert.ok(!runs(jobs[name]).some((command) => /\bnpm (ci|install|i)\b/.test(command)))
  }
})

test('nothing is signed or published before every gate passes', () => {
  assert.deepEqual([...jobs['sign-windows'].needs].sort(), [...gates].sort())
  assert.equal(jobs['sign-windows'].if, "needs.windows.outputs.sign == 'true'")

  const publish = jobs.publish
  assert.deepEqual([...publish.needs].sort(), [...gates, 'sign-windows'].sort())
  for (const name of gates) {
    assert.ok(publish.if.includes(`needs.${name}.result == 'success'`), `publish must need ${name}`)
  }
  assert.ok(publish.if.includes("github.ref_type == 'tag'"))
  assert.ok(
    publish.if.includes(
      "(needs.sign-windows.result == 'success' || needs.windows.outputs.sign != 'true')"
    )
  )

  // The publisher takes every SideKick-* artifact; the installer awaiting a signature must not
  // be one of them.
  const download = publish.steps.find((step) => step.uses?.startsWith('actions/download-artifact'))
  assert.equal(download.with.pattern, 'SideKick-*')
  const unsigned = jobs.windows.steps.find((step) => step.id === 'unsigned-installer')
  assert.ok(!unsigned.with.name.startsWith('SideKick-'))
  assert.equal(
    jobs.windows.outputs['unsigned-artifact-id'],
    '${{ steps.unsigned-installer.outputs.artifact-id }}'
  )
})
