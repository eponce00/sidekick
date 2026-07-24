const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { afterEach, test } = require('node:test')
const assert = require('node:assert/strict')
const {
  assertStableVersion,
  validateReleaseArtifacts,
  writeChecksums
} = require('./validate-release-artifacts.cjs')

const VERSION = '1.2.3'
const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true })
})

function createFixture(platform = 'all') {
  const directory = mkdtempSync(join(tmpdir(), 'sidekick-release-'))
  temporaryDirectories.push(directory)

  if (platform === 'all' || platform === 'windows') {
    writeFileSync(
      join(directory, `SideKick-${VERSION}-windows-x64-setup.exe`),
      'unsigned-community-installer'
    )
  }
  if (platform === 'all' || platform === 'macos') {
    writeFileSync(join(directory, `SideKick-${VERSION}-arm64.dmg`), 'community-dmg')
    writeFileSync(join(directory, `SideKick-${VERSION}-arm64.zip`), 'community-app-zip')
  }

  return directory
}

test('accepts the complete community artifact set and writes checksums', () => {
  const directory = createFixture()
  const names = validateReleaseArtifacts({ directory, platform: 'all', version: VERSION })
  writeChecksums(directory, names)

  const checksums = readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8')
  assert.equal(checksums.trim().split('\n').length, names.length)
  assert.match(checksums, new RegExp(`SideKick-${VERSION}-windows-x64-setup\\.exe`))
  assert.match(checksums, new RegExp(`SideKick-${VERSION}-arm64\\.zip`))
})

test('accepts each platform artifact set before CI upload', () => {
  const windows = createFixture('windows')
  const macos = createFixture('macos')

  assert.doesNotThrow(() =>
    validateReleaseArtifacts({ directory: windows, platform: 'windows', version: VERSION })
  )
  assert.doesNotThrow(() =>
    validateReleaseArtifacts({ directory: macos, platform: 'macos', version: VERSION })
  )
})

test('ignores builder diagnostics, obsolete update metadata, and unpacked directories', () => {
  const directory = createFixture('macos')
  writeFileSync(join(directory, 'builder-debug.yml'), 'debug: true')
  writeFileSync(join(directory, 'builder-effective-config.yaml'), 'productName: SideKick')
  writeFileSync(join(directory, 'latest-mac.yml'), 'obsolete: true')
  writeFileSync(join(directory, `SideKick-${VERSION}-arm64.zip.blockmap`), 'obsolete')
  mkdirSync(join(directory, 'mac-arm64'))

  assert.doesNotThrow(() =>
    validateReleaseArtifacts({ directory, platform: 'macos', version: VERSION })
  )
})

test('rejects builder diagnostics from the final public artifact set', () => {
  const directory = createFixture()
  writeFileSync(join(directory, 'builder-debug.yml'), 'debug: true')

  assert.throws(
    () => validateReleaseArtifacts({ directory, platform: 'all', version: VERSION }),
    /does not match the community release contract/
  )
})

test('rejects obsolete update metadata from the final public artifact set', () => {
  const directory = createFixture()
  writeFileSync(join(directory, 'latest-mac.yml'), 'obsolete: true')
  writeFileSync(join(directory, `SideKick-${VERSION}-arm64.zip.blockmap`), 'obsolete')

  assert.throws(
    () => validateReleaseArtifacts({ directory, platform: 'all', version: VERSION }),
    /does not match the community release contract/
  )
})

test('rejects unexpected or obsolete community artifacts', () => {
  const directory = createFixture('windows')
  writeFileSync(join(directory, `SideKick-${VERSION}-windows-x64-portable.exe`), 'portable')

  assert.throws(
    () => validateReleaseArtifacts({ directory, platform: 'windows', version: VERSION }),
    /does not match the community release contract/
  )
})

test('rejects prerelease and non-semver release versions', () => {
  assert.throws(() => assertStableVersion('1.2.3-beta.1'), /stable semver/)
  assert.throws(() => assertStableVersion('v1.2.3'), /stable semver/)
})

test('does not create checksums until explicitly requested', () => {
  const directory = createFixture('windows')
  validateReleaseArtifacts({ directory, platform: 'windows', version: VERSION })
  assert.equal(existsSync(join(directory, 'SHA256SUMS.txt')), false)
})
