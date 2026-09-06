const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const { tmpdir, homedir } = require('node:os')
const { readFileSync } = require('node:fs')
const { assertOwnedTemporary } = require('./qualify-packaged-upgrade.cjs')

test('upgrade cleanup refuses broad or unrelated directories', () => {
  for (const invalid of [
    tmpdir(),
    homedir(),
    path.parse(tmpdir()).root,
    path.join(tmpdir(), 'unrelated-profile'),
    path.join(tmpdir(), '..', 'sidekick-upgrade-escape')
  ]) {
    assert.throws(() => assertOwnedTemporary(invalid), invalid)
  }
  const owned = path.join(tmpdir(), 'sidekick-upgrade-synthetic')
  assert.equal(assertOwnedTemporary(owned), path.resolve(owned))
})

test('qualification launches only extracted apps with isolated profile arguments, not installers', () => {
  const source = readFileSync(path.join(__dirname, 'qualify-packaged-upgrade.cjs'), 'utf8')
  assert.match(source, /execFileSync\(sevenZip,/)
  assert.doesNotMatch(source, /(?:spawn|execFileSync)\(installer/)
  assert.match(
    source,
    /args: \['--disable-gpu', '--sidekick-packaged-smoke-test', '--sidekick-e2e'\]/
  )
  assert.match(source, /SIDEKICK_E2E_USER_DATA_DIR: profile/)
  assert.match(source, /app\.getPath\('userData'\)/)
  assert.match(source, /Current package changed during qualification/)
})
