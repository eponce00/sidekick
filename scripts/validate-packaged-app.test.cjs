const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  validatePackageEntries,
  validateResourceEntries
} = require('./validate-packaged-app.cjs')

const requiredPdfEntries = [
  '/node_modules/@napi-rs/canvas/index.js',
  '/node_modules/pdfjs-dist/build/pdf.min.mjs',
  '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  '/node_modules/pdfjs-dist/legacy/build/pdf.mjs'
]

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
  for (const root of ['coverage', 'docs', 'scripts', 'src']) {
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

test('rejects legacy automatic-updater configuration from packaged resources', () => {
  assert.doesNotThrow(() => validateResourceEntries(['app.asar', 'icon.icns']))
  assert.throws(
    () => validateResourceEntries(['app.asar', 'app-update.yml']),
    /obsolete updater configuration/
  )
})
