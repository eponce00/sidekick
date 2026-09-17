/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'

const stage = process.argv[2] || 'final'
const root = new URL('../', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')
const exists = async (path) => {
  try {
    await access(new URL(path, root), constants.F_OK)
    return true
  } catch {
    return false
  }
}

const [html, css, app] = await Promise.all([
  read('index.html'),
  read('styles.css'),
  read('src/app.js')
])

assert.equal(await exists('obsolete.txt'), false, 'obsolete.txt must be removed')
assert.equal(await exists('src/theme.js'), true, 'src/theme.js must be added')
assert.match(app, /sidekick-comprehensive-eval/, 'The sentinel must be preserved')
assert.match(app, /from\s+["']\.\/theme\.js["']/, 'app.js must import the new theme module')
assert.match(app, /Ready/, 'The initial status must be changed with a localized edit')
assert.match(html, /id=["']mode-toggle["']/)
assert.match(html, /id=["']controller-status["']/)
assert.match(css, /--accent\s*:/, 'The reference accent must be represented as a CSS variable')

if (stage === 'final') {
  assert.match(html, /class=["'][^"']*console__metrics[^"']*["']/)
  assert.match(html, /data-metric=["']latency["']/)
  assert.match(html, /data-metric=["']throughput["']/)
  assert.match(css, /@media\s*\([^)]*max-width\s*:\s*600px/i)
  assert.match(css, /overflow-x\s*:\s*hidden/i)
}

console.log(`Comprehensive agent ${stage} contract passed`)
