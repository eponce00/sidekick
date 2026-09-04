#!/usr/bin/env node

const { existsSync, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { listPackage } = require('@electron/asar')

const FORBIDDEN_ROOTS = new Set([
  '.claude',
  '.github',
  'coverage',
  'dist',
  'docs',
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
  'win32-x64': [
    'node_modules',
    '@napi-rs',
    'canvas-win32-x64-msvc',
    'skia.win32-x64-msvc.node'
  ]
}

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

module.exports = { requiredPdfNativeBinding, validatePackageEntries, validateResourceEntries }
