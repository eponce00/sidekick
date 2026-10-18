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
  ['build/icon.svg', '6ea14e12dbc42ee71bb5ccfe7c5c1c1a8d971da8814a23b3e2825794d469a726'],
  ['build/icon-small.svg', '044f7a2ffd8bcda5d83e292ffe71234a3d6df19c38a20189a21518c9b043773c'],
  [
    'src/renderer/src/assets/sidekick-peek.svg',
    'c32f72441e8af637d1bdcb9ffa43c90d37f11b011b95c344be7f27b8ce919b35'
  ],
  ['build/icon.icns', '4b222af043091f9086b064e45eb62acfefe52d955a48ad3a88c9b84de24f7099'],
  ['build/icon.ico', 'ad540ec6e8ab9b2ecc47c319947c51982402ba17d2288d7de737ca754ae0ab52'],
  ['resources/icon.png', '706052f0bdcf2dc57587ec531740a8c46bc2ffc6e19e4482b4fe2656042349bc'],
  ['resources/tray.png', 'ba9e54f54f1acd95c2d5c9448cfa1f9ece98f1c12bd06fde40147656d2a888d6'],
  ['build/appx/LargeTile.png', 'cd3abcd06a6cd446f1c232ee5889cd94a34e48b1e168968308a4e1c0ed3fdfb3'],
  ['build/appx/SmallTile.png', '068ca30262f8e4836a4a3f5a8519d254fa2704d0a3c96ebf44eb8f83567b77f8'],
  [
    'build/appx/Square150x150Logo.png',
    'a9a8ff8b81a4f2af2185e5b25cfab808ef859756ea366f313cb104badd07f5c4'
  ],
  [
    'build/appx/Square44x44Logo.png',
    'd183461ac587237a9e2b96a975992562842fe0780a60c2efc37b706e931165bd'
  ],
  ['build/appx/StoreLogo.png', 'a30d1d2a3bb8bfbab5bc391d65371772ab27a294aa7a22e188dc2de2ac81974a'],
  [
    'build/appx/Wide310x150Logo.png',
    'fdf5aa32017a08436e4256a6f2471fc8ae18ea3122f6a1fa57771bab6976f2e1'
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
