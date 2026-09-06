const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { test } = require('node:test')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { validateQualificationManifest: validate } = require('./validate-qualification-manifest.cjs')

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

test('CLI binds actual artifact/report files and never echoes rejected private input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sidekick-qualification-'))
  try {
    const { manifest, options } = fixture()
    const manifestPath = join(directory, 'manifest.json')
    const artifactPath = join(directory, 'artifact.bin')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    writeFileSync(artifactPath, options.artifactBytes)
    writeFileSync(join(directory, 'synthetic-case.json'), options.reportBytes['synthetic-case'])
    const run = () =>
      spawnSync(
        process.execPath,
        [
          join(__dirname, 'validate-qualification-manifest.cjs'),
          manifestPath,
          artifactPath,
          options.sourceCommit,
          directory
        ],
        { encoding: 'utf8' }
      )
    const accepted = run()
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.match(accepted.stdout, /identity unverified/)
    writeFileSync(manifestPath, '{"apiKey":"SYNTHETIC_PRIVATE_VALUE",invalid}')
    const rejected = run()
    assert.equal(rejected.status, 1)
    assert.doesNotMatch(rejected.stderr + rejected.stdout, /SYNTHETIC_PRIVATE_VALUE|apiKey/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
function fixture() {
  const artifactBytes = Buffer.from('synthetic package bytes')
  const report = Buffer.from('{"synthetic":true}')
  const sourceCommit = 'a'.repeat(40)
  const manifest = {
    schemaVersion: 1,
    claim: 'evidence',
    app: { version: '0.7.0', sourceCommit, dirty: true, artifactSha256: hash(artifactBytes) },
    model: {
      requested: 'local-loaded-model',
      reported: 'local-loaded-model',
      before: null,
      after: null
    },
    results: [
      {
        scenario: 'synthetic-case',
        scope: 'kernel',
        samples: 20,
        passed: 20,
        falseCompletions: 0,
        safetyViolations: 0,
        reportSha256: hash(report)
      }
    ]
  }
  return {
    manifest,
    options: { artifactBytes, sourceCommit, reportBytes: { 'synthetic-case': report } }
  }
}

function qualify(f) {
  f.manifest.claim = 'qualified'
  f.manifest.app.dirty = false
  const observed = {
    checkpoint: 'org/checkpoint',
    revision: 'b'.repeat(40),
    runtimeDigest: 'c'.repeat(64)
  }
  f.manifest.model.before = structuredClone(observed)
  f.manifest.model.after = structuredClone(observed)
  f.options.trustedModelIdentity = {
    before: structuredClone(observed),
    after: structuredClone(observed)
  }
  return f
}

test('gateway aliases and unknown observations remain unverified', () => {
  const { manifest, options } = fixture()
  assert.equal(validate(manifest, options).identity, 'unverified')
  manifest.model.reported = null
  assert.equal(validate(manifest, options).identity, 'unverified')
})

test('supplied observations alone cannot promote model identity', () => {
  const { manifest, options } = qualify(fixture())
  delete options.trustedModelIdentity
  assert.throws(() => validate(manifest, options), /trusted out-of-band/)
  manifest.claim = 'evidence'
  assert.equal(validate(manifest, options).identity, 'unverified')
})

test('qualified evidence binds clean source, package, reports and operator-attested identity', () => {
  const { manifest, options } = qualify(fixture())
  assert.deepEqual(validate(manifest, options), {
    claim: 'qualified',
    identity: 'operator-attested',
    scenarios: 1
  })
  for (const mutation of [
    (f) => {
      f.options.artifactBytes = Buffer.from('changed')
    },
    (f) => {
      f.options.sourceCommit = 'd'.repeat(40)
    },
    (f) => {
      f.options.reportBytes['synthetic-case'] = Buffer.from('changed')
    },
    (f) => {
      f.manifest.app.dirty = true
    },
    (f) => {
      f.manifest.model.after.revision = 'e'.repeat(40)
    },
    (f) => {
      f.options.trustedModelIdentity.after.runtimeDigest = 'f'.repeat(64)
    }
  ]) {
    const f = qualify(fixture())
    mutation(f)
    assert.throws(() => validate(f.manifest, f.options))
  }
})

test('qualified claims reject failures, false completion and safety violations', () => {
  for (const [key, value] of [
    ['passed', 19],
    ['falseCompletions', 1],
    ['safetyViolations', 1]
  ]) {
    const { manifest, options } = qualify(fixture())
    manifest.results[0][key] = value
    assert.throws(() => validate(manifest, options))
    manifest.claim = 'evidence'
    assert.doesNotThrow(() => validate(manifest, options))
  }
})

test('strict schema rejects free text, extra sensitive fields, missing reports and traversal', () => {
  for (const mutation of [
    (f) => {
      f.manifest.apiKey = 'synthetic-sensitive-value'
    },
    (f) => {
      f.manifest.app.version = ['0.7.0']
    },
    (f) => {
      f.manifest.model.reported = 'prompt with spaces'
    },
    (f) => {
      f.manifest.results[0].scenario = '../private'
    },
    (f) => {
      f.manifest.results[0].samples = 0
    },
    (f) => {
      f.manifest.results.push(structuredClone(f.manifest.results[0]))
    },
    (f) => {
      delete f.options.reportBytes
    },
    (f) => {
      f.manifest.results[0].passed = 21
    }
  ]) {
    const f = fixture()
    mutation(f)
    assert.throws(() => validate(f.manifest, f.options))
  }
})
