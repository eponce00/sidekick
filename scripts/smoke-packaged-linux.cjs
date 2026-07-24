const { execFileSync, spawn } = require('node:child_process')
const {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const identity = require('../src/shared/productIdentity.json')

const smokeSeconds = Number.parseInt(process.env.SIDEKICK_SMOKE_SECONDS || '8', 10)

function findPackagedExecutable() {
  const requestedPath = process.argv[2]
  if (requestedPath) {
    const executable = resolve(requestedPath)
    if (!existsSync(executable) || !statSync(executable).isFile()) {
      throw new Error(`Packaged Linux executable does not exist: ${executable}`)
    }
    return executable
  }

  const unpackedExecutable = resolve('dist', 'linux-unpacked', identity.appId)
  if (existsSync(unpackedExecutable)) return unpackedExecutable

  const appImages = readdirSync(resolve('dist'))
    .filter((name) => /^SideKick-.+-linux-x64\.AppImage$/.test(name))
    .map((name) => resolve('dist', name))
  if (appImages.length !== 1) {
    throw new Error(
      `Expected one Linux package at ${unpackedExecutable} or one x64 AppImage; found ${appImages.length}.`
    )
  }
  return appImages[0]
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('The packaged Linux smoke test must run on Linux.')
  }

  const executable = findPackagedExecutable()
  accessSync(executable, constants.X_OK)
  const profile = mkdtempSync(join(tmpdir(), 'sidekick-linux-smoke-'))
  const stdoutPath = join(profile, 'stdout.log')
  const stderrPath = join(profile, 'stderr.log')
  const stdout = openSync(stdoutPath, 'w')
  const stderr = openSync(stderrPath, 'w')
  let child

  try {
    child = spawn(
      executable,
      [
        `--user-data-dir=${profile}`,
        '--enable-logging=stderr',
        '--disable-gpu',
        '--sidekick-packaged-smoke-test'
      ],
      {
        detached: true,
        env: { ...process.env },
        stdio: ['ignore', stdout, stderr]
      }
    )
    closeSync(stdout)
    closeSync(stderr)

    await delay(smokeSeconds * 1000)
    const logs = readFileSync(stderrPath, 'utf8')
    const fatalPattern =
      /uncaught|fatal|failed to load|module.*not found|unable to load preload|sandbox.*failed/i

    if (child.exitCode !== null) {
      throw new Error(`Packaged app exited during smoke test with code ${child.exitCode}.\n${logs}`)
    }
    if (fatalPattern.test(logs)) {
      throw new Error(`Packaged app emitted a fatal startup error.\n${logs}`)
    }

    const matchingProcesses = execFileSync('pgrep', ['-f', profile], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    if (matchingProcesses.length < 2) {
      throw new Error(
        `Expected Electron child processes, found ${matchingProcesses.length}.\n${logs}`
      )
    }

    console.log(
      `Packaged Linux smoke test passed for ${executable} (${matchingProcesses.length} Electron processes).`
    )
  } finally {
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
        await delay(500)
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The process group may already be gone.
      }
    } else {
      closeSync(stdout)
      closeSync(stderr)
    }
    rmSync(profile, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
