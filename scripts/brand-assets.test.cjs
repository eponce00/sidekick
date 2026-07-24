const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const builder = require(path.join(root, 'electron-builder.config.cjs'))
const masterIconPath = path.join(root, 'build/icon.svg')
const runtimeIconPath = path.join(root, 'resources/icon.png')

const EXPECTED_BRAND_ASSET_HASHES = new Map([
  ['build/icon.svg', '83271a158063c4301745e5ec3d62faef5270f629b52fdffc3375d77bd7fc4f09'],
  ['build/icon.icns', '9ef53e406637a7232ff50b33d48c61942fcda89ee2e163e36f0e7e01faccb7c2'],
  ['build/icon.ico', '95a0e5eca4b6c880ca2e233bc1c3cb5d033c05f70966a421eb44ade7d87a2e0b'],
  ['resources/icon.png', 'a33d94be784307b96cecb34984ea0c2b1c4bc291ee69220bd4140648f5ab936e']
])

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

function canonicalAssetContents(relativePath, contents) {
  return relativePath === 'build/icon.svg'
    ? Buffer.from(contents.toString('utf8').replaceAll('\r\n', '\n'))
    : contents
}

test('normalizes irrelevant vector line endings before hashing', () => {
  assert.equal(
    canonicalAssetContents('build/icon.svg', Buffer.from('<svg>\r\n</svg>\r\n')).toString(),
    '<svg>\n</svg>\n'
  )
})

test('uses deterministic platform derivatives of one SideKick vector master', () => {
  assert.equal(builder.mac.icon, 'build/icon.icns')
  assert.equal(builder.win.icon, 'build/icon.ico')

  const svg = readFileSync(masterIconPath, 'utf8')
  assert.match(svg, /<svg\b/)
  assert.match(svg, /viewBox="0 0 2048 2048"/)
  assert.equal(RETIRED_ELECTRON_ICON_HASHES.has(sha256(svg)), false)

  for (const [relativePath, expectedHash] of EXPECTED_BRAND_ASSET_HASHES) {
    const rawContents = readFileSync(path.join(root, relativePath))
    const contents = canonicalAssetContents(relativePath, rawContents)
    assert.equal(sha256(contents), expectedHash, `${relativePath} must match the vector master`)
    assert.equal(RETIRED_ELECTRON_ICON_HASHES.has(expectedHash), false)
  }
})

test('keeps no obsolete or theme-duplicated icon assets', () => {
  for (const obsolete of [
    'build/icon.png',
    'resources/icon.ico',
    'resources/icon-dark.png',
    'resources/icon-light.png',
    'resources/icon.svg'
  ]) {
    assert.equal(existsSync(path.join(root, obsolete)), false, `${obsolete} must not be restored`)
  }

  const png = readFileSync(runtimeIconPath)
  const icns = readFileSync(path.join(root, 'build/icon.icns'))
  const ico = readFileSync(path.join(root, 'build/icon.ico'))
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns')
  assert.deepEqual(ico.subarray(0, 4), Buffer.from([0x00, 0x00, 0x01, 0x00]))
  assert.deepEqual(
    png.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  )
  assert.equal(png.readUInt32BE(16), 1024)
  assert.equal(png.readUInt32BE(20), 1024)
  assert.equal(png[25], 6, 'runtime icon must be an RGBA PNG')
  assert.equal(RETIRED_ELECTRON_ICON_HASHES.has(sha256(png)), false)
})
