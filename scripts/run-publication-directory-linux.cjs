const assert = require('node:assert/strict')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, relative, resolve, isAbsolute } = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { build } = require('esbuild')
const ROOT = resolve(__dirname, '..')
const IMAGE = 'node:24-bookworm-slim'
const docker = (args, timeout = 15000) =>
  promisify(execFile)('docker', args, { windowsHide: true, timeout, maxBuffer: 256 * 1024 })
function argumentsForContainer(name, bundle, imageId) {
  assert.match(name, /^sidekick-publication-linux-[a-f0-9-]{36}$/)
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/)
  assert.ok(isAbsolute(bundle))
  return [
    'create',
    '--name',
    name,
    '--pull',
    'never',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '65534:65534',
    '--pids-limit',
    '64',
    '--memory',
    '256m',
    '--cpus',
    '1',
    '--mount',
    `type=bind,src=${bundle},dst=/qualification,readonly`,
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
    '--env',
    'SIDEKICK_PUBLICATION_LINUX_FIXTURE=1',
    imageId,
    'node',
    '--test',
    '--test-reporter=tap',
    '/qualification/test.cjs'
  ]
}
function removeBundle(bundle) {
  const actual = fs.realpathSync(bundle),
    temporary = fs.realpathSync(tmpdir()),
    rel = relative(temporary, actual)
  assert.ok(
    dirname(actual) === temporary &&
      rel.startsWith('sidekick-publication-linux-bundle-') &&
      !isAbsolute(rel)
  )
  fs.rmSync(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
async function run() {
  let stage = 'image_inspection',
    bundle,
    primary,
    report,
    attemptedCreate = false
  const name = `sidekick-publication-linux-${randomUUID()}`
  try {
    // Inspect only the existing local tag, then pin execution to that exact image ID.
    const image = JSON.parse((await docker(['image', 'inspect', IMAGE])).stdout)[0]
    assert.equal(image.Os, 'linux')
    stage = 'bundle'
    bundle = fs.mkdtempSync(join(tmpdir(), 'sidekick-publication-linux-bundle-'))
    const inputs = ['src/main/utils/publicationDirectory.ts', 'src/main/utils/atomicNewFile.ts']
    const sourceHashes = Object.fromEntries(
      inputs.map((file) => [
        file,
        createHash('sha256')
          .update(fs.readFileSync(join(ROOT, file)))
          .digest('hex')
      ])
    )
    await build({
      entryPoints: [join(ROOT, 'scripts/publication-directory-linux.entry.ts')],
      outfile: join(bundle, 'test.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      logLevel: 'silent'
    })
    const bundleSha256 = createHash('sha256')
      .update(fs.readFileSync(join(bundle, 'test.cjs')))
      .digest('hex')
    stage = 'container_create'
    attemptedCreate = true
    await docker(argumentsForContainer(name, bundle, image.Id))
    const configured = JSON.parse((await docker(['inspect', name])).stdout)[0]
    assert.equal(configured.HostConfig.ReadonlyRootfs, true)
    assert.equal(configured.HostConfig.NetworkMode, 'none')
    assert.ok(configured.HostConfig.Tmpfs['/tmp'])
    assert.equal(configured.Mounts.length, 1)
    assert.equal(configured.Mounts[0].Destination, '/qualification')
    assert.equal(configured.Mounts[0].RW, false)
    stage = 'tests'
    const started = Date.now()
    const output = (await docker(['start', '--attach', name], 60000)).stdout
    const completed = JSON.parse((await docker(['inspect', name])).stdout)[0]
    assert.equal(completed.State.Running, false)
    assert.equal(completed.State.ExitCode, 0)
    assert.match(output, /# fail 0\b/)
    const environmentLine = output
      .split(/\r?\n/)
      .find((line) => line.includes('PUBLICATION_LINUX_ENV='))
    assert.ok(environmentLine)
    const environment = JSON.parse(environmentLine.split('PUBLICATION_LINUX_ENV=')[1])
    const tests = Number(output.match(/# tests (\d+)/)?.[1])
    assert.equal(tests, 10)
    report = {
      schemaVersion: 1,
      passed: true,
      qualification: 'linux_container_tmpfs_helpers_not_desktop',
      imageTag: IMAGE,
      imageId: image.Id,
      repoDigests: image.RepoDigests,
      ...environment,
      tests,
      sourceHashes,
      bundleSha256,
      elapsedMs: Date.now() - started
    }
  } catch {
    primary = { schemaVersion: 1, passed: false, stage }
    throw primary
  } finally {
    const cleanup = []
    let containerGone = !attemptedCreate
    if (attemptedCreate) {
      try {
        await docker(['rm', '--force', name])
        const remaining = (
          await docker(['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'])
        ).stdout.trim()
        assert.equal(remaining, '')
        containerGone = true
      } catch {
        cleanup.push('owned_container_exit_unconfirmed')
      }
    }
    if (bundle) {
      try {
        if (containerGone) removeBundle(bundle)
        else cleanup.push('bundle_retained')
      } catch {
        cleanup.push('bundle_cleanup_failed')
      }
    }
    if (cleanup.length) {
      if (primary) primary.cleanup = cleanup
      else throw { schemaVersion: 1, passed: false, stage: 'cleanup', cleanup }
    }
  }
  return { ...report, ownedContainerRemoved: true, ownedBundleRemoved: true }
}
module.exports = { argumentsForContainer, removeBundle, run }
if (require.main === module) {
  if (process.env.SIDEKICK_PUBLICATION_LINUX_RUN !== '1')
    console.log('SKIP: explicit SIDEKICK_PUBLICATION_LINUX_RUN=1 required')
  else
    run()
      .then((report) => console.log(JSON.stringify(report)))
      .catch((error) => {
        console.error(
          JSON.stringify({
            schemaVersion: 1,
            passed: false,
            stage: error?.stage ?? 'configuration',
            cleanup: error?.cleanup ?? []
          })
        )
        process.exitCode = 1
      })
}
