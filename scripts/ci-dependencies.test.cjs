const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const YAML = require('yaml')
const { dependencyCacheKey } = require('./dependency-cache-key.cjs')

const lockfile = (version, edit = () => undefined) => {
  const value = {
    name: 'sidekick',
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'sidekick',
        version,
        dependencies: { react: '^19.2.4' }
      },
      'node_modules/react': {
        version: '19.2.4',
        resolved: 'https://registry.npmjs.org/react/-/react-19.2.4.tgz',
        integrity: 'sha512-react'
      }
    }
  }
  edit(value)
  return JSON.stringify(value, null, 2)
}

test('a release that only bumps SideKick’s version keeps the dependency cache', () => {
  assert.equal(
    dependencyCacheKey(lockfile('0.16.0'), '24.21.0\n'),
    dependencyCacheKey(lockfile('0.16.1'), '24.21.0\n')
  )
})

test('any change to what npm ci installs changes the key', () => {
  const key = dependencyCacheKey(lockfile('0.16.1'), '24.21.0')
  const changes = [
    (value) => (value.packages['node_modules/react'].version = '19.2.5'),
    (value) => (value.packages['node_modules/react'].integrity = 'sha512-other'),
    (value) => (value.packages[''].dependencies.react = '^19.3.0'),
    (value) => (value.packages['node_modules/react-dom'] = { version: '19.2.4' }),
    (value) => delete value.packages['node_modules/react'],
    // A dependency of SideKick's own name still counts.
    (value) => (value.packages['node_modules/sidekick'] = { version: '0.16.1' })
  ]
  for (const change of changes) {
    assert.notEqual(dependencyCacheKey(lockfile('0.16.1', change), '24.21.0'), key)
  }
  assert.notEqual(dependencyCacheKey(lockfile('0.16.1'), '24.22.0'), key)
})

const yaml = (...path) =>
  YAML.parse(readFileSync(join(__dirname, '..', '.github', ...path), 'utf8'))
const prepare = yaml('actions', 'prepare', 'action.yml')

test('every clean install gets one more attempt after a transient failure', () => {
  const jobs = [
    ['prepare', prepare.runs.steps],
    ...['release.yml', 'store.yml'].flatMap((file) =>
      Object.entries(yaml('workflows', file).jobs).map(([name, job]) => [
        `${file} ${name}`,
        job.steps
      ])
    )
  ]
  let installs = 0
  for (const [name, steps] of jobs) {
    steps.forEach((step, index) => {
      if (step.run !== 'npm ci' || step.if === `steps.${steps[index - 1]?.id}.outcome == 'failure'`)
        return
      installs++
      assert.ok(step.id && step['continue-on-error'] === true, `${name} must let npm ci fail once`)
      const retry = steps[index + 1]
      assert.equal(retry?.run, 'npm ci', `${name} must retry npm ci`)
      assert.equal(retry.if, `steps.${step.id}.outcome == 'failure'`)
      assert.ok(!retry['continue-on-error'], `${name} must fail when the retry fails`)
    })
  }
  assert.ok(installs >= 5)
})

test('CI keys its installed dependencies on the dependency hash', () => {
  const steps = prepare.runs.steps
  const hash = steps.find((step) => step.run?.includes('scripts/dependency-cache-key.cjs'))
  const restore = steps.find((step) => step.uses?.startsWith('actions/cache'))
  assert.ok(hash && restore && steps.indexOf(hash) < steps.indexOf(restore))
  assert.equal(restore.with.path, 'node_modules')
  assert.ok(restore.with.key.includes(`\${{ steps.${hash.id}.outputs.hash }}`))
  assert.ok(!restore.with.key.includes('hashFiles'))
})
