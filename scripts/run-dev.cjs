const { execFileSync, spawn } = require('node:child_process')
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { join, resolve } = require('node:path')
const identity = require('../src/shared/productIdentity.json')

const APP_NAME = identity.productName
const APP_ID = identity.developmentAppId
const projectRoot = resolve(__dirname, '..')

function setPlistValue(plistPath, key, type, value) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plistPath])
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plistPath])
  }
}

function prepareMacRuntime() {
  const electronVersion = require(join(projectRoot, 'node_modules/electron/package.json')).version
  const sourceApp = join(projectRoot, 'node_modules/electron/dist/Electron.app')
  const runtimeRoot = join(projectRoot, 'node_modules/.cache/sidekick-electron', electronVersion)
  const targetApp = join(runtimeRoot, 'Electron.app')
  const markerPath = join(runtimeRoot, '.sidekick-runtime')
  const expectedMarker = `${APP_NAME}\n${APP_ID}\n${electronVersion}\n`

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

  const iconPath = join(projectRoot, 'build/icon.icns')
  if (existsSync(iconPath)) {
    copyFileSync(iconPath, join(targetApp, 'Contents/Resources/electron.icns'))
  }

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
