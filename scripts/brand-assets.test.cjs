const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const builder = require(path.join(root, 'electron-builder.config.cjs'))
const masterIconPath = path.join(root, 'build/icon.svg')
const runtimeIconPath = path.join(root, 'resources/icon.png')

const RETIRED_ELECTRON_ICON_HASHES = new Set([
  '0fde45a54168829a207f3f24d8ef622b6a271adf4b673f4720342108446c3cc2',
  '4363016ccf3541c84ae6a1eee83f507fb2b775aa89b9d6c8163875640267f9e9',
  '4dda94d0a2a07b15628c3c82564de0ea8f4ff57d366a3a7fc8a73594af095c66',
  '90d550a64c9636806837f8ecbab2c6af3e428a28aaae50e1672ac18c7d040bc1',
  'f04ab537bca077b93d1f1864f123652bae08c2f7f51d948a8d7ec5e48a35ba2d'
])

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

test('uses one SideKick vector master for every packaged platform', () => {
  assert.equal(builder.mac.icon, 'build/icon.svg')
  assert.equal(builder.win.icon, 'build/icon.svg')

  const svg = readFileSync(masterIconPath, 'utf8')
  assert.match(svg, /<svg\b/)
  assert.match(svg, /viewBox="0 0 2048 2048"/)
  assert.equal(RETIRED_ELECTRON_ICON_HASHES.has(sha256(svg)), false)
})

test('keeps only the master vector and one runtime raster', () => {
  for (const obsolete of [
    'build/icon.icns',
    'build/icon.ico',
    'build/icon.png',
    'resources/icon.ico',
    'resources/icon-dark.png',
    'resources/icon-light.png',
    'resources/icon.svg'
  ]) {
    assert.equal(existsSync(path.join(root, obsolete)), false, `${obsolete} must not be restored`)
  }

  const png = readFileSync(runtimeIconPath)
  assert.deepEqual(
    png.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  )
  assert.equal(png.readUInt32BE(16), 1024)
  assert.equal(png.readUInt32BE(20), 1024)
  assert.equal(png[25], 6, 'runtime icon must be an RGBA PNG')
  assert.equal(RETIRED_ELECTRON_ICON_HASHES.has(sha256(png)), false)
})
