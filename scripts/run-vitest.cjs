const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const electronRoot = join(__dirname, '..', 'node_modules', 'electron', 'dist')
const executable =
  process.platform === 'darwin'
    ? join(electronRoot, 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : process.platform === 'win32'
      ? join(electronRoot, 'electron.exe')
      : join(electronRoot, 'electron')
const vitest = join(__dirname, '..', 'node_modules', 'vitest', 'vitest.mjs')
// Release artifact tests use node:test and have their own `npm run test:release` lane.
// Keep Vitest from executing those CJS files and then treating them as empty suites.
const nodeTestExcludes = ['--exclude', 'scripts/*.test.cjs']
// Windows process creation, git fixtures, and coverage instrumentation contend heavily when
// Vitest uses the machine-wide worker default. A bounded pool keeps exit-code/cancellation
// integration tests deterministic and prevents orphaned PowerShell trees on CI and laptops.
const platformLimits =
  process.platform === 'win32'
    ? ['--maxWorkers=1', '--testTimeout=15000', '--hookTimeout=15000']
    : []
const result = spawnSync(
  executable,
  [vitest, 'run', ...nodeTestExcludes, ...platformLimits, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  }
)

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
