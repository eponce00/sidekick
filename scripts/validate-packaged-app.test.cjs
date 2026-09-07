const { test } = require('node:test')
const assert = require('node:assert/strict')
const builder = require('../electron-builder.config.cjs')
const {
  requiredPdfNativeBinding,
  validatePackageEntries,
  validateResourceEntries
} = require('./validate-packaged-app.cjs')

const requiredPdfEntries = [
  '/node_modules/@napi-rs/canvas/index.js',
  '/node_modules/pdfjs-dist/build/pdf.min.mjs',
  '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  '/node_modules/pdfjs-dist/legacy/build/pdf.mjs'
]

test('packaging explicitly excludes Python bytecode and cache directories', () => {
  assert(builder.files.includes('!**/__pycache__{,/**/*}'))
  assert(builder.files.includes('!**/*.{pyc,pyo}'))
})

test('packaging excludes dormant Office validators but retains supported helper roots', () => {
  assert(builder.files.includes('!resources/skills/office/validators{,/**/*}'))
  assert(builder.files.includes('resources/**/*'))
  const base = [
    '/LICENSE',
    '/node_modules/a',
    '/out/main/index.js',
    '/package.json',
    ...requiredPdfEntries
  ]
  assert.doesNotThrow(() =>
    validatePackageEntries([
      ...base,
      ...[
        'structure.py',
        'validate.py',
        'pack.py',
        'unpack.py',
        'render.py',
        'helpers/merge_runs.py'
      ].map((name) => `/resources/skills/office/${name}`)
    ])
  )
  for (const entry of [
    '/resources/skills/office/validators',
    '/resources/skills/office/validators/base.py',
    'resources/skills/office/validators/docx.py',
    '\\resources\\skills\\office\\validators\\pptx.py',
    '/resources/skills/office/VALIDATORS/__init__.py'
  ])
    assert.throws(() => validatePackageEntries([...base, entry]), /dormant Office validators/)
})

test('archive audit rejects Python caches while preserving skill source', () => {
  const base = [
    '/LICENSE',
    '/node_modules/a',
    '/out/main/index.js',
    '/package.json',
    ...requiredPdfEntries
  ]
  assert.doesNotThrow(() => validatePackageEntries([...base, '/resources/skills/pdf/fill.py']))
  for (const entry of [
    '/resources/skills/pdf/__pycache__',
    '/resources/skills/pdf/__pycache__/fill.cpython-313.pyc',
    '/resources/skills/xlsx/helper.pyc',
    '/resources/skills/docx/helper.pyo',
    '\\resources\\skills\\pdf\\__pycache__\\fill.cpython-313.pyc'
  ]) {
    assert.throws(() => validatePackageEntries([...base, entry]), /Python bytecode cache/)
  }
})

test('accepts the minimal production runtime archive roots', () => {
  assert.doesNotThrow(() =>
    validatePackageEntries([
      '/LICENSE',
      '/node_modules/electron-log/package.json',
      '/out/main/index.js',
      '/out/preload/index.js',
      '/out/renderer/index.html',
      '/package.json',
      '/resources/icon.png',
      ...requiredPdfEntries
    ])
  )
})

test('normalizes Windows ASAR path separators before auditing roots', () => {
  assert.doesNotThrow(() =>
    validatePackageEntries([
      '\\LICENSE',
      '\\node_modules\\electron-log\\package.json',
      '\\out\\main\\index.js',
      '\\out\\preload\\index.js',
      '\\out\\renderer\\index.html',
      '\\package.json',
      '\\resources\\icon.png',
      ...requiredPdfEntries.map((entry) => entry.replaceAll('/', '\\'))
    ])
  )
})

test('rejects development and release tooling from the packaged archive', () => {
  for (const root of [
    'coverage',
    'docs',
    'scripts',
    'src',
    'output',
    'tmp',
    'reports',
    'artifacts',
    'test-results',
    '.codex',
    '.agents',
    'memory'
  ]) {
    for (const forbiddenEntry of [`/${root}/file`, `\\${root}\\file`]) {
      assert.throws(
        () =>
          validatePackageEntries([
            '/LICENSE',
            '/node_modules/a',
            '/out/main/index.js',
            '/package.json',
            ...requiredPdfEntries,
            forbiddenEntry
          ]),
        new RegExp(root)
      )
    }
  }
})

test('requires the project license in every packaged application', () => {
  assert.throws(
    () =>
      validatePackageEntries([
        '/node_modules/a',
        '/out/main/index.js',
        '/package.json',
        ...requiredPdfEntries
      ]),
    /LICENSE/
  )
})

test('requires the first-party browser PDF runtime in the packaged archive', () => {
  const entries = [
    '/LICENSE',
    '/node_modules/a',
    '/out/main/index.js',
    '/package.json',
    ...requiredPdfEntries.slice(1)
  ]
  assert.throws(() => validatePackageEntries(entries), /PDF runtime entry/)
})

test('requires the native PDF renderer for every shipped platform', () => {
  assert.deepEqual(requiredPdfNativeBinding('darwin', 'arm64'), [
    'node_modules',
    '@napi-rs',
    'canvas-darwin-arm64',
    'skia.darwin-arm64.node'
  ])
  assert.deepEqual(requiredPdfNativeBinding('linux', 'x64'), [
    'node_modules',
    '@napi-rs',
    'canvas-linux-x64-gnu',
    'skia.linux-x64-gnu.node'
  ])
  assert.deepEqual(requiredPdfNativeBinding('win32', 'x64'), [
    'node_modules',
    '@napi-rs',
    'canvas-win32-x64-msvc',
    'skia.win32-x64-msvc.node'
  ])
  assert.throws(() => requiredPdfNativeBinding('plan9', 'mips'), /Unsupported PDF renderer/)
})

test('rejects legacy automatic-updater configuration from packaged resources', () => {
  assert.doesNotThrow(() => validateResourceEntries(['app.asar', 'icon.icns']))
  assert.throws(
    () => validateResourceEntries(['app.asar', 'app-update.yml']),
    /obsolete updater configuration/
  )
})
