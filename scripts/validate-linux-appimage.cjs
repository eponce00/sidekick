#!/usr/bin/env node

const { execFileSync } = require('node:child_process')
const {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const identity = require('../src/shared/productIdentity.json')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function parseDesktopEntry(contents) {
  return new Map(
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('['))
      .map((line) => {
        const separator = line.indexOf('=')
        assert(separator > 0, `Invalid desktop entry line: ${line}`)
        return [line.slice(0, separator), line.slice(separator + 1)]
      })
  )
}

function validateDesktopEntry(contents, appId, productName) {
  const entry = parseDesktopEntry(contents)
  assert(entry.get('Name') === productName, `Linux desktop Name must be ${productName}.`)
  assert(
    entry.get('StartupWMClass') === appId,
    `Linux StartupWMClass must match the application id ${appId}.`
  )
  assert(entry.get('Icon') === appId, `Linux desktop Icon must match ${appId}.`)
  assert(entry.get('Terminal') === 'false', 'Linux desktop launcher must not open a terminal.')
  assert(entry.get('Type') === 'Application', 'Linux desktop entry must describe an application.')
  assert(
    (entry.get('Categories') || '').split(';').includes('Development'),
    'Linux desktop entry must use the Development category.'
  )
  assert(entry.get('Exec'), 'Linux desktop entry is missing its executable.')
  assert(
    !entry.get('Exec').includes('--no-sandbox'),
    'Linux desktop entry must not disable the Electron sandbox.'
  )
}

function validateLinuxAppImage(appImagePath) {
  const absolutePath = resolve(appImagePath)
  assert(existsSync(absolutePath), `Missing Linux AppImage: ${absolutePath}`)
  assert(statSync(absolutePath).isFile(), `Linux AppImage is not a file: ${absolutePath}`)
  assert(statSync(absolutePath).size > 0, `Linux AppImage is empty: ${absolutePath}`)
  accessSync(absolutePath, constants.X_OK)

  const extractionDirectory = mkdtempSync(join(tmpdir(), 'sidekick-appimage-'))
  try {
    execFileSync(absolutePath, ['--appimage-extract'], {
      cwd: extractionDirectory,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 120_000
    })
    const root = join(extractionDirectory, 'squashfs-root')
    assert(existsSync(root), 'AppImage extraction did not create squashfs-root.')
    accessSync(join(root, 'AppRun'), constants.X_OK)
    assert(
      existsSync(join(root, 'resources', 'app.asar')),
      'AppImage is missing resources/app.asar.'
    )

    const desktopName = `${identity.appId}.desktop`
    const desktopEntries = readdirSync(root).filter((name) => name.endsWith('.desktop'))
    assert(
      desktopEntries.length === 1 && desktopEntries[0] === desktopName,
      `AppImage desktop entry must be exactly ${desktopName}; received ${desktopEntries.join(', ')}.`
    )
    validateDesktopEntry(
      readFileSync(join(root, desktopName), 'utf8'),
      identity.appId,
      identity.productName
    )
    assert(
      existsSync(join(root, `${identity.appId}.svg`)),
      `AppImage is missing its canonical ${identity.appId}.svg launcher icon.`
    )
  } finally {
    rmSync(extractionDirectory, { recursive: true, force: true })
  }
}

if (require.main === module) {
  try {
    assert(process.platform === 'linux', 'Linux AppImage validation must run on Linux.')
    assert(process.argv[2], 'Usage: validate-linux-appimage.cjs <appimage-path>')
    validateLinuxAppImage(process.argv[2])
    console.log(`Validated Linux AppImage: ${process.argv[2]}.`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { parseDesktopEntry, validateDesktopEntry, validateLinuxAppImage }
