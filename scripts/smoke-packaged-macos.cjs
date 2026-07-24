const { execFileSync, spawn } = require('node:child_process')
const {
  closeSync,
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

const smokeSeconds = Number.parseInt(process.env.SIDEKICK_SMOKE_SECONDS || '8', 10)
const allowUnsignedBundle = process.env.SIDEKICK_ALLOW_UNSIGNED_SMOKE === 'true'

function findPackagedApp() {
  const requestedPath = process.argv[2]
  if (requestedPath) {
    const appPath = resolve(requestedPath)
    if (!existsSync(appPath) || !statSync(appPath).isDirectory()) {
      throw new Error(`Packaged macOS app does not exist: ${appPath}`)
    }
    return appPath
  }

  const distPath = resolve('dist')
  const appCandidates = readdirSync(distPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .map((entry) => join(distPath, entry.name, 'SideKick.app'))
  const appPath = appCandidates[0]
  if (!appPath) throw new Error('No packaged macOS app found under dist/mac*/SideKick.app')
  return appPath
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function main() {
  const appPath = findPackagedApp()
  const executable = join(appPath, 'Contents', 'MacOS', 'SideKick')
  const profile = mkdtempSync(join(tmpdir(), 'sidekick-smoke-'))
  const stdoutPath = join(profile, 'stdout.log')
  const stderrPath = join(profile, 'stderr.log')
  const stdout = openSync(stdoutPath, 'w')
  const stderr = openSync(stderrPath, 'w')
  let child

  try {
    try {
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
        stdio: 'inherit'
      })
    } catch (error) {
      if (!allowUnsignedBundle) throw error
      console.warn('Skipping strict signature requirement for an intentionally unsigned PR bundle.')
    }
    child = spawn(
      executable,
      [
        `--user-data-dir=${profile}`,
        '--enable-logging=stderr',
        '--disable-gpu',
        '--sidekick-packaged-smoke-test'
      ],
      { detached: true, stdio: ['ignore', stdout, stderr] }
    )
    closeSync(stdout)
    closeSync(stderr)

    await delay(smokeSeconds * 1000)
    const logs = readFileSync(stderrPath, 'utf8')
    const fatalPattern = /uncaught|fatal|failed to load|module.*not found|unable to load preload/i

    if (child.exitCode !== null) {
      throw new Error(`Packaged app exited during smoke test with code ${child.exitCode}.\n${logs}`)
    }
    if (fatalPattern.test(logs)) {
      throw new Error(`Packaged app emitted a fatal startup error.\n${logs}`)
    }

    const matchingProcesses = execFileSync('/usr/bin/pgrep', ['-f', profile], {
      encoding: 'utf8'
    })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    if (matchingProcesses.length < 2) {
      throw new Error(
        `Expected Electron child processes, found ${matchingProcesses.length}.\n${logs}`
      )
    }

    console.log(
      `Packaged macOS smoke test passed (${matchingProcesses.length} Electron processes).`
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
