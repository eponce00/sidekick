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
  ['build/icon.svg', 'a4c94a2927cec25931c738f7fb328a4a3d73cc16ca2b71f8c097788ab01cd13e'],
  ['build/icon-small.svg', '044f7a2ffd8bcda5d83e292ffe71234a3d6df19c38a20189a21518c9b043773c'],
  [
    'src/renderer/src/assets/sidekick-peek.svg',
    '37ec3c5c4c7163bc4cdc02307880a4306f774adbf351b68f3bb3806907e47367'
  ],
  ['build/icon.icns', 'aee07806def5a9882fef3f695661720815fe1e94e2e09ae9a0d8ac1d6c74849a'],
  ['build/icon.ico', '1bbd0dc990be9b89a604375baebbb96b567691aeea366ffab9b746fa2589abfe'],
  ['resources/icon.png', '9077c627e836f0df96caa563db3d35308eeac8698de102dacb6551f1fe3de57c'],
  ['resources/tray.png', 'ba9e54f54f1acd95c2d5c9448cfa1f9ece98f1c12bd06fde40147656d2a888d6'],
  ['build/appx/LargeTile.png', '70e5c2c88d72e71f5dd737981ca4fc6afcf23a116300602d0f86a6eeb4112200'],
  ['build/appx/SmallTile.png', '068ca30262f8e4836a4a3f5a8519d254fa2704d0a3c96ebf44eb8f83567b77f8'],
  [
    'build/appx/Square150x150Logo.png',
    'd9ec079a7bbc1300143b880cf224bd29385ee9092bae2844185f1475d45ccfb4'
  ],
  [
    'build/appx/Square44x44Logo.png',
    'd183461ac587237a9e2b96a975992562842fe0780a60c2efc37b706e931165bd'
  ],
  [
    'build/appx/Square44x44Logo.targetsize-16_altform-unplated.png',
    '067514857a8c78746688a40c637cf851ecf8cec8a89c3578a60d25a54473a8eb'
  ],
  [
    'build/appx/Square44x44Logo.targetsize-24_altform-unplated.png',
    '9849cdc7b6ed76b4e306edfd022b631638da6074d12ba6c1d070842c8f9a0891'
  ],
  [
    'build/appx/Square44x44Logo.targetsize-32_altform-unplated.png',
    '4374af24cd0f305e9d1eb72b1cb80b8c6049333ec5548daec47360a1c6b86418'
  ],
  [
    'build/appx/Square44x44Logo.targetsize-48_altform-unplated.png',
    '8f48e53d2bc0c141875681522004b99319081068c6829ced39ea15d31256149c'
  ],
  [
    'build/appx/Square44x44Logo.targetsize-256_altform-unplated.png',
    '0136c4385bcf660b832c8960b85952efa3fb0c9755a6622b40238adc7caf8ca8'
  ],
  ['build/appx/StoreLogo.png', 'a30d1d2a3bb8bfbab5bc391d65371772ab27a294aa7a22e188dc2de2ac81974a'],
  [
    'build/appx/Wide310x150Logo.png',
    '9948255fe2fad6858f93bbb367990114cfd008270a4a9d096e115307a1476c98'
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

test('prints the console shield on the cape instead of fastening a disk under the face', () => {
  const svg = readFileSync(path.join(root, 'src/renderer/src/assets/sidekick-peek.svg'), 'utf8')
  const rig = svg.match(/<g class="peek-cape-rig">([\s\S]*?)<\/g>/)?.[1]
  assert.ok(rig)
  assert.match(rig, /class="peek-emblem"/)
  assert.match(rig, /class="peek-emblem-mark"/)
  assert.ok(rig.indexOf('peek-emblem') < rig.indexOf('peek-cape-lining'))
  assert.doesNotMatch(svg, /peek-badge/)
  const mark = rig.match(/class="peek-emblem-mark" d="([^"]+)"/)?.[1]
  assert.equal(mark?.match(/M/g)?.length, 2, 'prompt and cursor must be separate strokes')
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
