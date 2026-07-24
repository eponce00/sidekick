const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  validatePackageEntries,
  validateResourceEntries
} = require('./validate-packaged-app.cjs')

test('accepts the minimal production runtime archive roots', () => {
  assert.doesNotThrow(() =>
    validatePackageEntries([
      '/LICENSE',
      '/node_modules/electron-log/package.json',
      '/out/main/index.js',
      '/out/preload/index.js',
      '/out/renderer/index.html',
      '/package.json',
      '/resources/icon.png'
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
      '\\resources\\icon.png'
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
            forbiddenEntry
          ]),
        new RegExp(root)
      )
    }
  }
})

test('requires the project license in every packaged application', () => {
  assert.throws(
    () => validatePackageEntries(['/node_modules/a', '/out/main/index.js', '/package.json']),
    /LICENSE/
  )
})

test('rejects legacy automatic-updater configuration from packaged resources', () => {
  assert.doesNotThrow(() => validateResourceEntries(['app.asar', 'icon.icns']))
  assert.throws(
    () => validateResourceEntries(['app.asar', 'app-update.yml']),
    /obsolete updater configuration/
  )
})
