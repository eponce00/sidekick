#!/usr/bin/env node

const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { listPackage } = require('@electron/asar')
const identity = require('../src/shared/productIdentity.json')

const FORBIDDEN_ROOTS = new Set([
  '.claude',
  '.github',
  'coverage',
  'dist',
  'docs',
  'output',
  'reports',
  'artifacts',
  'test-results',
  'playwright-report',
  '.codex',
  '.agents',
  'memory',
  'tmp',
  'scripts',
  'src'
])
const FORBIDDEN_RESOURCE_FILES = new Set(['app-update.yml'])
const REQUIRED_PDF_RUNTIME_ENTRIES = [
  '/node_modules/@napi-rs/canvas/index.js',
  '/node_modules/pdfjs-dist/build/pdf.min.mjs',
  '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  '/node_modules/pdfjs-dist/legacy/build/pdf.mjs'
]
const REQUIRED_PDF_SKILL_ASSETS = [
  ['resources', 'skills', 'pdf', 'check_fillable_fields.py'],
  ['resources', 'skills', 'pdf', 'fill_fillable_fields.py']
]
const PDF_NATIVE_BINDINGS = {
  'darwin-arm64': ['node_modules', '@napi-rs', 'canvas-darwin-arm64', 'skia.darwin-arm64.node'],
  'linux-x64': ['node_modules', '@napi-rs', 'canvas-linux-x64-gnu', 'skia.linux-x64-gnu.node'],
  'win32-x64': ['node_modules', '@napi-rs', 'canvas-win32-x64-msvc', 'skia.win32-x64-msvc.node']
}

// Electron's fuse wire: this marker, a version byte, a length byte, then one byte per fuse.
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
// The fuses electron-builder.config.cjs sets, by their position in version 1 of the wire.
const REQUIRED_FUSES = [
  ['RunAsNode', '1'],
  ['EnableCookieEncryption', '1'],
  ['EnableNodeOptionsEnvironmentVariable', '1'],
  ['EnableNodeCliInspectArguments', '0'],
  ['EnableEmbeddedAsarIntegrityValidation', '1'],
  ['OnlyLoadAppFromAsar', '1']
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function validatePackageEntries(entries) {
  const roots = new Set(
    entries.map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, '').split('/')[0])
  )
  for (const root of FORBIDDEN_ROOTS) {
    assert(!roots.has(root), `Packaged app contains development-only root: ${root}`)
  }
  for (const required of ['LICENSE', 'node_modules', 'out', 'package.json']) {
    assert(roots.has(required), `Packaged app is missing runtime root: ${required}`)
  }

  const normalized = new Set(entries.map((entry) => entry.replaceAll('\\', '/')))
  for (const entry of normalized) {
    assert(
      !/^\/?resources\/skills\/office\/validators(?:\/|$)/i.test(entry),
      'Packaged app contains dormant Office validators'
    )
    assert(
      !/(?:^|\/)__pycache__(?:\/|$)|\.(?:pyc|pyo)$/i.test(entry),
      'Packaged app contains a local Python bytecode cache'
    )
  }
  for (const required of REQUIRED_PDF_RUNTIME_ENTRIES) {
    assert(normalized.has(required), `Packaged app is missing PDF runtime entry: ${required}`)
  }
}

function validateResourceEntries(entries) {
  for (const forbidden of FORBIDDEN_RESOURCE_FILES) {
    assert(
      !entries.includes(forbidden),
      `Packaged app contains obsolete updater configuration: ${forbidden}`
    )
  }
}

function requiredPdfNativeBinding(platform = process.platform, arch = process.arch) {
  const binding = PDF_NATIVE_BINDINGS[`${platform}-${arch}`]
  assert(binding, `Unsupported PDF renderer target: ${platform}-${arch}`)
  return binding
}

function validateFuseWire(binary) {
  const start = binary.indexOf(FUSE_SENTINEL)
  assert(start !== -1, 'Packaged Electron binary has no fuse wire')
  const wire = start + FUSE_SENTINEL.length
  assert(binary[wire] === 1, `Packaged Electron binary has fuse wire version ${binary[wire]}`)
  assert(binary[wire + 1] >= REQUIRED_FUSES.length, 'Packaged Electron fuse wire is too short')
  REQUIRED_FUSES.forEach(([name, expected], index) => {
    const actual = String.fromCharCode(binary[wire + 2 + index])
    assert(actual === expected, `Packaged Electron fuse ${name} is ${actual}, expected ${expected}`)
  })
}

/** The file holding the fuse wire, relative to the packaged resources directory. */
function fuseBinaryPath(resourcesDirectory, platform = process.platform) {
  if (platform === 'darwin') {
    return join(
      resourcesDirectory,
      '..',
      'Frameworks',
      'Electron Framework.framework',
      'Electron Framework'
    )
  }
  if (platform === 'win32') return join(resourcesDirectory, '..', `${identity.productName}.exe`)
  return join(resourcesDirectory, '..', identity.appId)
}

function validatePackagedApp(resourcesDirectory) {
  const root = resolve(resourcesDirectory)
  const asarPath = join(root, 'app.asar')
  assert(existsSync(asarPath), `Missing packaged archive: ${asarPath}`)
  validateResourceEntries(readdirSync(root))
  validatePackageEntries(listPackage(asarPath))

  const unpackedRoot = join(root, 'app.asar.unpacked')
  for (const pathParts of REQUIRED_PDF_SKILL_ASSETS) {
    const assetPath = join(unpackedRoot, ...pathParts)
    assert(existsSync(assetPath), `Packaged app is missing PDF skill asset: ${assetPath}`)
  }
  const nativeBinding = join(unpackedRoot, ...requiredPdfNativeBinding())
  assert(existsSync(nativeBinding), `Packaged app is missing PDF native renderer: ${nativeBinding}`)
  validateFuseWire(readFileSync(fuseBinaryPath(root)))
}

if (require.main === module) {
  try {
    assert(process.argv[2], 'Usage: validate-packaged-app.cjs <resources-directory>')
    validatePackagedApp(process.argv[2])
    console.log(`Validated packaged runtime in ${process.argv[2]}.`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = {
  fuseBinaryPath,
  requiredPdfNativeBinding,
  validateFuseWire,
  validatePackageEntries,
  validateResourceEntries
}
