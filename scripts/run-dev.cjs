const { execFileSync, spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const identity = require('../src/shared/productIdentity.json')

const APP_NAME = identity.productName
const APP_ID = identity.developmentAppId
const projectRoot = resolve(__dirname, '..')

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function setPlistValue(plistPath, key, type, value) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plistPath])
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plistPath])
  }
}

function writeMacIcon(sourcePath, destinationPath, runtimeRoot) {
  const iconsetPath = join(runtimeRoot, 'SideKick.iconset')
  rmSync(iconsetPath, { recursive: true, force: true })
  mkdirSync(iconsetPath)

  for (const [points, scale] of [
    [16, 1],
    [16, 2],
    [32, 1],
    [32, 2],
    [128, 1],
    [128, 2],
    [256, 1],
    [256, 2],
    [512, 1],
    [512, 2]
  ]) {
    const pixels = points * scale
    const suffix = scale === 2 ? '@2x' : ''
    execFileSync('/usr/bin/sips', [
      '-z',
      String(pixels),
      String(pixels),
      sourcePath,
      '--out',
      join(iconsetPath, `icon_${points}x${points}${suffix}.png`)
    ])
  }

  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconsetPath, '-o', destinationPath])
  rmSync(iconsetPath, { recursive: true, force: true })
}

function prepareMacRuntime() {
  const electronVersion = require(join(projectRoot, 'node_modules/electron/package.json')).version
  const sourceApp = join(projectRoot, 'node_modules/electron/dist/Electron.app')
  const runtimeRoot = join(projectRoot, 'node_modules/.cache/sidekick-electron', electronVersion)
  const targetApp = join(runtimeRoot, 'Electron.app')
  const markerPath = join(runtimeRoot, '.sidekick-runtime')
  const iconPath = join(projectRoot, 'resources/icon.png')
  const expectedMarker = `${APP_NAME}\n${APP_ID}\n${electronVersion}\n${sha256(iconPath)}\n`

  if (existsSync(markerPath) && readFileSync(markerPath, 'utf8') === expectedMarker) {
    return runtimeRoot
  }

  if (!existsSync(sourceApp)) {
    throw new Error(`Electron development bundle was not found at ${sourceApp}`)
  }

  rmSync(runtimeRoot, { recursive: true, force: true })
  mkdirSync(runtimeRoot, { recursive: true })

  // APFS copy-on-write keeps the branded development bundle fast and inexpensive.
  // Fall back to a regular recursive copy when clonefile is unavailable.
  try {
    execFileSync('/bin/cp', ['-cR', sourceApp, targetApp])
  } catch {
    execFileSync('/bin/cp', ['-R', sourceApp, targetApp])
  }

  const plistPath = join(targetApp, 'Contents/Info.plist')
  setPlistValue(plistPath, 'CFBundleName', 'string', APP_NAME)
  setPlistValue(plistPath, 'CFBundleDisplayName', 'string', APP_NAME)
  setPlistValue(plistPath, 'CFBundleIdentifier', 'string', APP_ID)

  writeMacIcon(iconPath, join(targetApp, 'Contents/Resources/electron.icns'), runtimeRoot)

  // Editing a bundle invalidates Electron's upstream signature. An ad-hoc development
  // signature gives macOS a coherent local app identity without requesting a certificate.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', targetApp], {
    stdio: 'inherit'
  })
  writeFileSync(markerPath, expectedMarker)
  return runtimeRoot
}

function main() {
  const env = { ...process.env }
  if (process.platform === 'darwin') {
    const runtimeRoot = prepareMacRuntime()
    env.ELECTRON_EXEC_PATH = join(runtimeRoot, 'Electron.app/Contents/MacOS/Electron')
  }

  const electronViteCli = join(projectRoot, 'node_modules/electron-vite/bin/electron-vite.js')
  const child = spawn(process.execPath, [electronViteCli, 'dev', ...process.argv.slice(2)], {
    cwd: projectRoot,
    env,
    stdio: 'inherit'
  })

  child.on('error', (error) => {
    console.error(error)
    process.exitCode = 1
  })
  child.on('exit', (code) => {
    process.exitCode = code ?? 0
  })
}

main()
