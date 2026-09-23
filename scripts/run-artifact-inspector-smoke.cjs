// Renders sample artifacts through the real inspection window and writes each
// capture to disk. By default the inspection page comes from the renderer dev
// server (npm run dev). With --production it comes from the built renderer in
// out/renderer (npm run build), the way a packaged app serves it.
const { spawn } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { buildSync } = require('esbuild')

const ROOT = resolve(__dirname, '..')
const RESULT_PREFIX = 'SIDEKICK_ARTIFACT_INSPECTOR_SMOKE='
const production = process.argv.includes('--production')
const rendererUrl = process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173'
const outputDirectory = resolve(
  process.argv.slice(2).find((argument) => !argument.startsWith('--')) ||
    join(ROOT, 'artifact-smoke')
)

// The protocol resolves built pages relative to the main bundle, so a
// production run places its bundle where the app's own main bundle lives.
const bundleRoot = production
  ? join(ROOT, 'out', 'artifact-smoke-main')
  : mkdtempSync(join(tmpdir(), 'sidekick-artifact-smoke-'))
const output = join(bundleRoot, 'main.cjs')
buildSync({
  entryPoints: [join(__dirname, 'artifact-inspector-smoke.entry.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'better-sqlite3', 'jsdom', 'canvas'],
  logLevel: 'error'
})

const environment = {
  ...process.env,
  SIDEKICK_ARTIFACT_SMOKE_OUT: outputDirectory,
  NODE_PATH: join(ROOT, 'node_modules')
}
delete environment.ELECTRON_RUN_AS_NODE
if (production) delete environment.ELECTRON_RENDERER_URL
else environment.ELECTRON_RENDERER_URL = rendererUrl

const child = spawn(require('electron'), [output], { cwd: ROOT, env: environment })
let stdout = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  stdout += chunk
})
child.stderr.on('data', (chunk) => process.stderr.write(chunk))
child.on('exit', (code) => {
  rmSync(bundleRoot, { recursive: true, force: true })
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(RESULT_PREFIX))
  if (!line) {
    console.error('No smoke result was reported')
    process.exit(1)
  }
  const results = JSON.parse(line.slice(RESULT_PREFIX.length))
  for (const result of results) {
    console.log(
      `${result.pass ? 'PASS' : 'FAIL'} ${result.name}: ${result.status ?? result.thrown} ` +
        `(${result.ms} ms${result.size ? `, ${result.size}, ${result.imageBytes} bytes` : ''}` +
        `${result.chatFrameHeight ? `, taller than the ${result.chatFrameHeight}px chat frame` : ''})` +
        (result.errors?.length ? `\n      errors: ${result.errors.join(' | ')}` : '')
    )
  }
  console.log(`Captures written to ${outputDirectory}`)
  process.exit(code ?? 1)
})
