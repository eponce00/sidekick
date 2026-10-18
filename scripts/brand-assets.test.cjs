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
  ['build/icon.svg', '917415777dfac30e57f327a308e4b430f5b3d4bb882833008ade0bf28d5f3052'],
  ['build/icon-small.svg', '7cd58904b676cf3d6f006aac2cbb906ff08e020434e9a067fc3ca159466a2e14'],
  [
    'src/renderer/src/assets/sidekick-peek.svg',
    '1c5bb38879f112754ee7c7b7c8ba05124a8ac8ca44693a6ac7c8920d9d866618'
  ],
  ['build/icon.icns', 'b06d139712aff0bf950dda9e96edd96b5417aac173937f36415060d700fa9600'],
  ['build/icon.ico', '5af59f08e4b3e632dadadbd9a6a735f1cd880df78a281cb89f845877451ecbb7'],
  ['resources/icon.png', 'ad06d787d28373cc29ab7319b0a1d3ac7f1bc604cae808381c11d8f7a168a894'],
  ['resources/tray.png', '2aba93710c83541fd004b2cd72f2635292ef39587a78477dc55474c6ecc90258'],
  ['build/appx/LargeTile.png', 'f196c0e4325a79df80866abc497dd9313e946d04375dd31ff2238fdf4e52122d'],
  ['build/appx/SmallTile.png', 'e991217fb06168af5775a550a065d546cd162188dc040eefb22f2cdbff9a3b6a'],
  [
    'build/appx/Square150x150Logo.png',
    '05648b873acfa4fa71fd5abf113caae10a1fed1924ec52e30a0c4fd76d33a8cb'
  ],
  [
    'build/appx/Square44x44Logo.png',
    '0b0ca72dfb93f9548cf82d2f7e8e8270f9abb5427cdd76252b078c17d6c1c862'
  ],
  ['build/appx/StoreLogo.png', '1ba937c57ed768ab733f6f1a2d7eed2236d81a95dc532dfd5940ac3466c8b2f7'],
  [
    'build/appx/Wide310x150Logo.png',
    '93919183a04c3b0042e5c115d448e1ceaa440fa67ab13a331e223a13eca2bb52'
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
