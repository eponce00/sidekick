// Runs the real-site browser flows in native-browser-sites.entry.ts against a real model, each in
// its own Electron process with a time limit, so one stuck site never holds up the rest. They use
// public sites, which change, so they are an opt-in evaluation rather than a test. Usage:
//   node scripts/run-browser-sites.cjs [scenario ...]
const { spawn } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { buildSync } = require('esbuild')
const { loadAgentEvalEnvironment } = require('./agent-eval-env.cjs')

const ROOT = resolve(__dirname, '..')
const LIMIT_MS = Number(process.env.SIDEKICK_BROWSER_SITES_LIMIT_MS || 420_000)
const SCENARIOS = [
  'wikipedia',
  'react-select',
  'mui',
  'timeanddate',
  'google-flights',
  'weather',
  'select2',
  'flatpickr',
  'github-branch',
  'wikipedia-language',
  'booking'
]

function run(bundle, scenario) {
  return new Promise((done) => {
    const root = mkdtempSync(join(tmpdir(), 'sidekick-browser-sites-'))
    const env = {
      ...process.env,
      SIDEKICK_NATIVE_BROWSER_SMOKE_ROOT: root,
      SIDEKICK_SITE_SCENARIO: scenario,
      NODE_PATH: join(ROOT, 'node_modules')
    }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(require('electron'), [bundle], { cwd: ROOT, env, windowsHide: true })
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', () => undefined)
    const timer = setTimeout(() => child.kill(), LIMIT_MS)
    child.once('exit', () => {
      clearTimeout(timer)
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      const line = stdout.split(/\r?\n/).find((text) => text.startsWith('SIDEKICK_SITE_RESULT='))
      done(
        line
          ? JSON.parse(line.slice('SIDEKICK_SITE_RESULT='.length))
          : {
              scenario,
              passed: false,
              phase: 'timed out',
              elapsedMs: LIMIT_MS,
              // Where it was when stopped: the last tools it started and finished.
              lastEvents: stdout
                .split(/\r?\n/)
                .filter((text) => text.startsWith('SIDEKICK_SITE_EVENT='))
                .slice(-6)
                .map((text) => JSON.parse(text.slice('SIDEKICK_SITE_EVENT='.length)))
            }
      )
    })
  })
}

async function main() {
  loadAgentEvalEnvironment()
  if (!process.env.SIDEKICK_AGENT_EVAL_API_KEY || !process.env.SIDEKICK_AGENT_EVAL_URL)
    throw new Error('Set SIDEKICK_AGENT_EVAL_API_KEY, _URL and _MODEL for the model to use')
  const chosen = process.argv.slice(2).length ? process.argv.slice(2) : SCENARIOS
  const bundleRoot = mkdtempSync(join(tmpdir(), 'sidekick-native-browser-bundle-'))
  const bundle = join(bundleRoot, 'sites.cjs')
  try {
    buildSync({
      entryPoints: [join(ROOT, 'scripts', 'native-browser-sites.entry.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron', 'better-sqlite3', '@napi-rs/canvas'],
      banner: {
        js: `require = require('node:module').createRequire(${JSON.stringify(join(ROOT, 'package.json'))});`
      },
      packages: 'external',
      loader: { '.md': 'text' },
      logLevel: 'silent'
    })
    let passed = 0
    for (const scenario of chosen) {
      const result = await run(bundle, scenario)
      if (result.passed) passed++
      const key = process.env.SIDEKICK_AGENT_EVAL_API_KEY
      console.log(JSON.stringify(result).replaceAll(key, '[redacted]'))
    }
    console.log(`Browser sites: ${passed}/${chosen.length} flows completed and verified.`)
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
