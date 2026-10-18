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
  // Drawn by scripts/generate-brand-assets.cjs: the masters, then everything rendered from them.
  ['build/icon.svg', 'e518896437ea7b4fc995afe6494a444b299a392d32d7cb5f63ab97cd13897707'],
  ['build/icon-small.svg', '218e6288c526629a493af1882f6229cf34e3c4ba17570919bc8a02b6bd48c55f'],
  [
    'src/renderer/src/assets/sidekick-peek.svg',
    '3345eea8c1873b728c97ba5d6fb850e3f1a0b6062937d2ff71760510d5da955e'
  ],
  ['build/icon.icns', '52223a8ab947c9e7d1f2617ea0c22c393c05a93bbd208660094fb73ffe44d149'],
  ['build/icon.ico', 'b58d2aea87d18f265570c7dea7e53ac6d1f8711e47cb2de10781a766a09bc9fd'],
  ['resources/icon.png', '1939b076184fa6616dc666cee8fd1336daae71e25e25a40301e453227869c49f'],
  ['resources/tray.png', 'dede0297c08d84ca9bdbd44ac69c7314af6fd16d5d0ba7e0740a9c17d7c6ac71'],
  ['build/appx/LargeTile.png', '67556d523cbebe05e80b093943b57e8cb3b982fcdd939d5539b4f6dca723a2c4'],
  ['build/appx/SmallTile.png', '8d2dbd97c0ff16eabbc3fdcbc56258a3de91aed10997cc02fc460b7af7fa9a37'],
  [
    'build/appx/Square150x150Logo.png',
    '54c2e1551093765ac9017325d8e498992df7f71800a36f047aa6224a6face909'
  ],
  [
    'build/appx/Square44x44Logo.png',
    'f192059fd6a69875d7e7c44a3e5603ab4b569064c431f7ed684bafeb23d65037'
  ],
  ['build/appx/StoreLogo.png', 'ed3a6b9ca291624cd4071d123a294cd24144caec1100800653344df7143e4c8d'],
  [
    'build/appx/Wide310x150Logo.png',
    '271eb4707905fea525642ed9b188c349e72ab2191822e3bbd5bb05b60ed776f8'
  ]
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
  return relativePath.endsWith('.svg')
    ? Buffer.from(contents.toString('utf8').replaceAll('\r\n', '\n'))
    : contents
}

test('normalizes irrelevant vector line endings before hashing', () => {
  assert.equal(
    canonicalAssetContents('build/icon.svg', Buffer.from('<svg>\r\n</svg>\r\n')).toString(),
    '<svg>\n</svg>\n'
  )
})

test('uses deterministic platform derivatives of one SideKick drawing', () => {
  assert.equal(builder.mac.icon, 'build/icon.icns')
  assert.equal(builder.win.icon, 'build/icon.ico')
  // Without its own tiles, the Store package would show Electron's default artwork.
  const { STORE_ASSETS } = require('./generate-brand-assets.cjs')
  for (const { name } of STORE_ASSETS) {
    assert.ok(EXPECTED_BRAND_ASSET_HASHES.has(`build/appx/${name}`), `${name} must be pinned`)
  }

  for (const master of [masterIconPath, path.join(root, 'build/icon-small.svg')]) {
    const svg = readFileSync(master, 'utf8')
    assert.match(svg, /<svg\b/)
    assert.match(svg, /viewBox="0 0 2048 2048"/)
    assert.equal(RETIRED_ELECTRON_ICON_HASHES.has(sha256(svg)), false)
  }

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
