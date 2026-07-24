const assert = require('node:assert/strict')
const test = require('node:test')
const { parseDesktopEntry, validateDesktopEntry } = require('./validate-linux-appimage.cjs')

const APP_ID = 'io.github.example.sidekick'

test('accepts a sandboxed desktop launcher with one stable Linux identity', () => {
  const contents = `[Desktop Entry]
Name=SideKick
Exec=AppRun %U
Terminal=false
Type=Application
Icon=${APP_ID}
StartupWMClass=${APP_ID}
Categories=Development;
`

  assert.equal(parseDesktopEntry(contents).get('Exec'), 'AppRun %U')
  assert.doesNotThrow(() => validateDesktopEntry(contents, APP_ID, 'SideKick'))
})

test('rejects mismatched launch identities and sandbox bypasses', () => {
  const contents = `[Desktop Entry]
Name=SideKick
Exec=AppRun --no-sandbox %U
Terminal=false
Type=Application
Icon=sidekick
StartupWMClass=sidekick
Categories=Development;
`

  assert.throws(() => validateDesktopEntry(contents, APP_ID, 'SideKick'), /StartupWMClass/)
  assert.throws(
    () => validateDesktopEntry(contents.replaceAll('sidekick', APP_ID), APP_ID, 'SideKick'),
    /sandbox/
  )
})
