#!/usr/bin/env node

const { createHash } = require('node:crypto')
const { existsSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')

const SUPPORTED_PLATFORMS = new Set(['all', 'macos', 'windows'])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertStableVersion(version) {
  assert(
    typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version),
    `Release version must be stable semver (x.y.z), received ${JSON.stringify(version)}`
  )
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function expectedArtifacts(version, platform) {
  assertStableVersion(version)
  assert(SUPPORTED_PLATFORMS.has(platform), `Unsupported release platform: ${platform}`)
  const expected = []

  if (platform === 'all' || platform === 'windows') {
    expected.push(`SideKick-${version}-windows-x64-setup.exe`)
  }
  if (platform === 'all' || platform === 'macos') {
    expected.push(`SideKick-${version}-arm64.dmg`, `SideKick-${version}-arm64.zip`)
  }

  return expected.sort()
}

function assertFile(directory, name) {
  const path = resolve(directory, name)
  assert(existsSync(path), `Missing release artifact: ${name}`)
  const stats = statSync(path)
  assert(stats.isFile(), `Release artifact is not a file: ${name}`)
  assert(stats.size > 0, `Release artifact is empty: ${name}`)
  return path
}

function validateReleaseArtifacts({ directory, platform = 'all', version }) {
  assertStableVersion(version)
  assert(SUPPORTED_PLATFORMS.has(platform), `Unsupported release platform: ${platform}`)
  const root = resolve(directory)
  assert(
    existsSync(root) && statSync(root).isDirectory(),
    `Artifact directory does not exist: ${root}`
  )

  const expected = expectedArtifacts(version, platform)
  for (const name of expected) assertFile(root, name)

  const ignoredBuildOutputs =
    platform === 'all' ? new Set() : new Set(['builder-debug.yml', 'builder-effective-config.yaml'])
  const actual = readdirSync(root)
    .filter((name) => statSync(resolve(root, name)).isFile())
    .filter(
      (name) =>
        name !== 'SHA256SUMS.txt' &&
        !ignoredBuildOutputs.has(name) &&
        !(
          platform !== 'all' &&
          (name.endsWith('.blockmap') || /^latest(?:-.+)?\.ya?ml$/.test(name))
        )
    )
    .sort()
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `Artifact set does not match the community release contract. Expected ${expected.join(', ')}; received ${actual.join(', ')}`
  )
  assert(
    !actual.some((name) => /portable/i.test(name)),
    'Portable executables are not community release artifacts'
  )

  return expected
}

function writeChecksums(directory, artifactNames) {
  const root = resolve(directory)
  const contents = artifactNames
    .slice()
    .sort()
    .map((name) => `${sha256(resolve(root, name))}  ${name}`)
    .join('\n')
  writeFileSync(resolve(root, 'SHA256SUMS.txt'), `${contents}\n`, { mode: 0o644 })
}

function parseArguments(argv) {
  let directory
  let platform = 'all'
  let version
  let shouldWriteChecksums = false

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--platform') platform = argv[++index]
    else if (value === '--version') version = argv[++index]
    else if (value === '--write-checksums') shouldWriteChecksums = true
    else if (!value.startsWith('-') && !directory) directory = value
    else throw new Error(`Unknown argument: ${value}`)
  }

  assert(
    directory,
    'Usage: validate-release-artifacts.cjs --version x.y.z [--platform all|macos|windows] [--write-checksums] <directory>'
  )
  assert(version, '--version is required')
  return { directory, platform, shouldWriteChecksums, version }
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2))
    const artifacts = validateReleaseArtifacts(options)
    if (options.shouldWriteChecksums) writeChecksums(options.directory, artifacts)
    console.log(
      `Validated ${artifacts.length} ${options.platform} community release artifacts for SideKick ${options.version}.`
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = {
  assertStableVersion,
  expectedArtifacts,
  validateReleaseArtifacts,
  writeChecksums
}
