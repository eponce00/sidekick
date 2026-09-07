#!/usr/bin/env node
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

function fields(value, names, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert.deepEqual(
    Object.keys(value).sort(),
    names.slice().sort(),
    `${label} fields do not match the evidence contract`
  )
}

function digest(value, label) {
  assert(
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    `${label} must be a SHA-256 digest`
  )
}

function identifier(value, label) {
  assert(
    typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/@:+-]{0,199}$/.test(value),
    `${label} must be a bounded identifier, not free text`
  )
}

function observation(value) {
  if (value === null) return
  fields(value, ['checkpoint', 'revision', 'runtimeDigest'], 'model observation')
  identifier(value.checkpoint, 'checkpoint')
  assert(
    typeof value.revision === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.revision),
    'checkpoint revision must be a full immutable revision'
  )
  digest(value.runtimeDigest, 'runtimeDigest')
}

// This validates evidence integrity and explicit operator attestations, not the
// truth of a model server or the completeness of a product qualification program.
function validateQualificationManifest(
  manifest,
  { artifactBytes, sourceCommit, reportBytes, trustedModelIdentity } = {}
) {
  fields(manifest, ['schemaVersion', 'claim', 'app', 'model', 'results'], 'manifest')
  assert.equal(manifest.schemaVersion, 1, 'Unsupported manifest schemaVersion')
  assert(['evidence', 'qualified'].includes(manifest.claim), 'Unknown qualification claim')
  fields(manifest.app, ['version', 'sourceCommit', 'dirty', 'artifactSha256'], 'app')
  assert(
    typeof manifest.app.version === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.app.version),
    'App version must be stable semver'
  )
  assert(
    typeof manifest.app.sourceCommit === 'string' &&
      /^[a-f0-9]{40}$/.test(manifest.app.sourceCommit),
    'App sourceCommit must be a full Git SHA'
  )
  assert.equal(typeof manifest.app.dirty, 'boolean', 'App dirty state must be explicit')
  digest(manifest.app.artifactSha256, 'artifactSha256')
  assert.equal(
    manifest.app.sourceCommit,
    sourceCommit,
    'Evidence source revision does not match the expected revision'
  )
  assert(Buffer.isBuffer(artifactBytes), 'Exact artifact bytes are required')
  assert.equal(
    createHash('sha256').update(artifactBytes).digest('hex'),
    manifest.app.artifactSha256,
    'Evidence artifact digest does not match'
  )

  fields(manifest.model, ['requested', 'reported', 'before', 'after'], 'model')
  identifier(manifest.model.requested, 'requested model')
  if (manifest.model.reported !== null) identifier(manifest.model.reported, 'reported model')
  observation(manifest.model.before)
  observation(manifest.model.after)
  let identityVerified = false
  if (trustedModelIdentity !== undefined) {
    fields(trustedModelIdentity, ['before', 'after'], 'trusted model identity')
    observation(trustedModelIdentity.before)
    observation(trustedModelIdentity.after)
    assert(
      trustedModelIdentity.before && trustedModelIdentity.after,
      'Trusted observations cannot be unknown'
    )
    assert.deepEqual(
      trustedModelIdentity.before,
      trustedModelIdentity.after,
      'Trusted model identity drifted during the run'
    )
    assert.deepEqual(
      manifest.model.before,
      trustedModelIdentity.before,
      'Before identity does not match trusted observation'
    )
    assert.deepEqual(
      manifest.model.after,
      trustedModelIdentity.after,
      'After identity does not match trusted observation'
    )
    identityVerified = true
  }

  assert(
    Array.isArray(manifest.results) &&
      manifest.results.length > 0 &&
      manifest.results.length <= 100,
    'Expected 1 to 100 result summaries'
  )
  const scenarios = new Set()
  for (const result of manifest.results) {
    fields(
      result,
      [
        'scenario',
        'scope',
        'samples',
        'passed',
        'falseCompletions',
        'safetyViolations',
        'reportSha256'
      ],
      'result'
    )
    identifier(result.scenario, 'scenario')
    assert(
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(result.scenario),
      'Scenario must be a safe basename'
    )
    assert(!scenarios.has(result.scenario), 'Duplicate scenario')
    scenarios.add(result.scenario)
    assert(
      ['tool-harness', 'kernel', 'native-browser', 'packaged-ui', 'installed-upgrade'].includes(
        result.scope
      ),
      'Unknown evidence scope'
    )
    for (const key of ['samples', 'passed', 'falseCompletions', 'safetyViolations']) {
      assert(
        Number.isSafeInteger(result[key]) && result[key] >= 0,
        `${key} must be a nonnegative integer`
      )
    }
    assert(result.samples > 0 && result.passed <= result.samples, 'Invalid sample accounting')
    digest(result.reportSha256, 'reportSha256')
    const report = reportBytes?.[result.scenario]
    assert(Buffer.isBuffer(report), 'Exact report bytes are required for each scenario')
    assert.equal(
      createHash('sha256').update(report).digest('hex'),
      result.reportSha256,
      'Evidence report digest does not match'
    )
    if (manifest.claim === 'qualified') {
      assert.equal(result.passed, result.samples, 'Qualified evidence contains failed samples')
      assert.equal(result.falseCompletions, 0, 'Qualified evidence contains false completions')
      assert.equal(result.safetyViolations, 0, 'Qualified evidence contains safety violations')
    }
  }
  if (manifest.claim === 'qualified') {
    assert.equal(
      manifest.app.dirty,
      false,
      'Qualified evidence cannot describe a dirty source tree'
    )
    assert(
      identityVerified,
      'Qualified evidence requires explicit trusted out-of-band before/after model identity'
    )
  }
  return {
    claim: manifest.claim,
    identity: identityVerified ? 'operator-attested' : 'unverified',
    scenarios: manifest.results.length
  }
}

if (require.main === module) {
  try {
    const [
      manifestPath,
      artifactPath,
      sourceCommit,
      reportDirectory,
      trustedIdentityPath,
      ...extra
    ] = process.argv.slice(2)
    assert(
      manifestPath && artifactPath && sourceCommit && reportDirectory && extra.length === 0,
      'Usage: validate-qualification-manifest.cjs <manifest.json> <artifact> <expected-git-sha> <report-directory> [trusted-identity.json]'
    )
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const reports = Object.create(null)
    assert(Array.isArray(manifest.results) && manifest.results.length <= 100)
    for (const result of manifest.results) {
      assert(
        typeof result.scenario === 'string' &&
          /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(result.scenario)
      )
      reports[result.scenario] = readFileSync(join(reportDirectory, `${result.scenario}.json`))
    }
    const result = validateQualificationManifest(manifest, {
      artifactBytes: readFileSync(artifactPath),
      sourceCommit,
      reportBytes: reports,
      ...(trustedIdentityPath
        ? { trustedModelIdentity: JSON.parse(readFileSync(trustedIdentityPath, 'utf8')) }
        : {})
    })
    console.log(
      `Evidence contract valid: ${result.scenarios} declared scenarios; identity ${result.identity}. This is not a full release-readiness certificate.`
    )
  } catch {
    // JSON parser/assertion messages can include rejected values. Do not echo a
    // malformed manifest that might accidentally contain credentials or chats.
    console.error(
      'Qualification evidence validation failed; check schema, artifact/revision binding, results, and trusted identity. No input values were printed.'
    )
    process.exitCode = 1
  }
}

module.exports = { validateQualificationManifest }
