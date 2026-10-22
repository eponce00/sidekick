// Runs the run-journal audit (scripts/audit-runs.entry.ts) under Electron's Node, which the
// native SQLite module is built for. Exit code: 0 nothing flagged, 1 something flagged, 2 error.
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { buildSync } = require('esbuild')

const ROOT = resolve(__dirname, '..')
const directory = mkdtempSync(join(tmpdir(), 'sidekick-audit-runs-'))
const output = join(directory, 'audit-runs.cjs')
try {
  buildSync({
    entryPoints: [join(ROOT, 'scripts', 'audit-runs.entry.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3', 'electron', '@napi-rs/canvas'],
    logLevel: 'warning'
  })
  const result = spawnSync(require('electron'), [output, ...process.argv.slice(2)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: join(ROOT, 'node_modules') },
    windowsHide: true
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 2
} finally {
  rmSync(directory, { recursive: true, force: true })
}
