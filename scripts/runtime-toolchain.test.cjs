const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const packageMetadata = require(path.join(root, 'package.json'))

test('keeps development, CI, and Electron on one Node.js runtime', () => {
  const canonicalNodeVersion = readFileSync(path.join(root, '.node-version'), 'utf8').trim()
  const canonicalNodeMajor = canonicalNodeVersion.split('.')[0]

  assert.match(canonicalNodeVersion, /^\d+\.\d+\.\d+$/)
  assert.equal(process.versions.node, canonicalNodeVersion)
  assert.equal(packageMetadata.engines.node, `${canonicalNodeMajor}.x`)
  assert.equal(packageMetadata.devEngines.runtime.name, 'node')
  assert.equal(packageMetadata.devEngines.runtime.version, `${canonicalNodeMajor}.x`)
  assert.equal(packageMetadata.devEngines.runtime.onFail, 'error')
  assert.equal(packageMetadata.scripts['install:electron'], 'install-electron --no')
  assert.match(packageMetadata.scripts.postinstall, /^npm run install:electron && /)

  const electronBinary = require('electron')
  const result = spawnSync(
    electronBinary,
    ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron})'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }
  )

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const embeddedRuntime = JSON.parse(result.stdout.trim())
  assert.deepEqual(embeddedRuntime, {
    node: canonicalNodeVersion,
    electron: packageMetadata.devDependencies.electron
  })
})
