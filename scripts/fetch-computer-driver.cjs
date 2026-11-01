#!/usr/bin/env node

// Fetches the pinned cua-driver (MIT, https://github.com/trycua/cua) that the Windows app ships for
// computer use. Runs before a Windows package is built, and before the development app starts. A
// file that doesn't match the pinned hash fails the build rather than ship. The hashes of the
// executables are also pinned in src/main/services/computerUseDriver.ts, which checks them at runtime.
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const VERSION = '0.38.0'
const FOLDER_NAME = `cua-driver-rs-${VERSION}-windows-x86_64`
const ZIP_URL = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}/${FOLDER_NAME}.zip`
const ZIP_SHA256 = '997f20114ad3db227a854e1e5a886234f76405b155f4af70605d4b7ca4a436a1'
const EXECUTABLES = {
  'cua-driver.exe': 'ffa58d88779ee219304b0c307f4cfa970fe822f830c6ecf9254eda5c29e22bf2',
  'cua-driver-uia.exe': '69aa6ea0049ce59dfd14593be77c0632f12f6eda3d4a2f4bab1a00e3a72a9754'
}
// The licence terms travel with the binaries.
const NOTICES = ['LICENSE', 'THIRD_PARTY_NOTICES.md']
const DESTINATION = resolve(__dirname, '..', 'build', 'computer-driver')

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function isPresent() {
  return (
    Object.entries(EXECUTABLES).every(
      ([name, hash]) =>
        existsSync(join(DESTINATION, name)) &&
        sha256(readFileSync(join(DESTINATION, name))) === hash
    ) && NOTICES.every((name) => existsSync(join(DESTINATION, name)))
  )
}

async function fetchComputerDriver() {
  if (isPresent()) return
  const response = await fetch(ZIP_URL)
  if (!response.ok) throw new Error(`Downloading cua-driver failed: HTTP ${response.status}`)
  const zip = Buffer.from(await response.arrayBuffer())
  if (sha256(zip) !== ZIP_SHA256)
    throw new Error('The cua-driver download does not match its pinned hash.')
  const scratch = mkdtempSync(join(tmpdir(), 'sidekick-computer-driver-'))
  try {
    const zipPath = join(scratch, 'driver.zip')
    writeFileSync(zipPath, zip)
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:SK_ZIP -DestinationPath $env:SK_OUT -Force'
      ],
      { env: { ...process.env, SK_ZIP: zipPath, SK_OUT: scratch }, stdio: 'inherit' }
    )
    rmSync(DESTINATION, { recursive: true, force: true })
    mkdirSync(DESTINATION, { recursive: true })
    for (const name of [...Object.keys(EXECUTABLES), ...NOTICES]) {
      copyFileSync(join(scratch, FOLDER_NAME, name), join(DESTINATION, name))
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  if (!isPresent()) throw new Error('The cua-driver files do not match their pinned hashes.')
}

/** electron-builder's `beforePack` hook. Only a Windows package ships the driver. */
async function beforePack(context) {
  if (context.electronPlatformName === 'win32') await fetchComputerDriver()
}

module.exports = beforePack
module.exports.fetchComputerDriver = fetchComputerDriver

if (require.main === module) {
  fetchComputerDriver().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
