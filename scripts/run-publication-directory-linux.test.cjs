const { test } = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { execFileSync } = require('node:child_process')
const { argumentsForContainer } = require('./run-publication-directory-linux.cjs')
test('does not launch Docker without explicit opt-in', () => {
  const result = execFileSync(
    process.execPath,
    [join(__dirname, 'run-publication-directory-linux.cjs')],
    { env: { ...process.env, SIDEKICK_PUBLICATION_LINUX_RUN: '' }, encoding: 'utf8' }
  )
  assert.match(result, /^SKIP:/)
})
test('pins an existing image and confines writes to isolated tmpfs', () => {
  const args = argumentsForContainer(
    'sidekick-publication-linux-00000000-0000-4000-8000-000000000000',
    join(tmpdir(), 'fixture'),
    'sha256:' + 'a'.repeat(64)
  )
  assert.equal(args[args.indexOf('--pull') + 1], 'never')
  assert.equal(args[args.indexOf('--network') + 1], 'none')
  assert.ok(args.includes('--read-only'))
  assert.equal(args[args.indexOf('--user') + 1], '65534:65534')
  assert.match(args[args.indexOf('--mount') + 1], /dst=\/qualification,readonly$/)
  assert.match(args[args.indexOf('--tmpfs') + 1], /^\/tmp:rw,noexec,nosuid,size=64m,mode=1777$/)
  assert.throws(() =>
    argumentsForContainer('other', join(tmpdir(), 'fixture'), 'sha256:' + 'a'.repeat(64))
  )
})
