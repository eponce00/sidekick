const { spawn } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve, sep } = require('node:path')
const { buildSync } = require('esbuild')

const ROOT = resolve(__dirname, '..')
if (process.argv.includes('--fixture-only')) process.env.SIDEKICK_BROWSER_FIXTURE_ONLY = '1'
const reliability = process.argv.includes('--reliability') || process.argv.includes('--fixture-only')
const liveAgent =
  process.argv.includes('--live-agent') ||
  (reliability && process.env.SIDEKICK_BROWSER_FIXTURE_ONLY !== '1')
const ENTRY = join(
  ROOT,
  'scripts',
  reliability
    ? 'native-browser-reliability.entry.ts'
    : liveAgent
      ? 'native-browser-agent.entry.ts'
      : 'native-browser-smoke.entry.ts'
)
const RESULT_PREFIX = 'SIDEKICK_NATIVE_BROWSER_SMOKE='

function removeBundleRoot(bundleRoot) {
  const expectedTemp = resolve(tmpdir())
  const resolvedRoot = resolve(bundleRoot)
  if (
    resolvedRoot.startsWith(`${expectedTemp}${sep}`) &&
    resolvedRoot.split(sep).at(-1).startsWith('sidekick-native-browser-bundle-')
  ) {
    rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

async function runElectron(output) {
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  environment.SIDEKICK_NATIVE_BROWSER_SMOKE_ROOT = join(dirname(output), 'runtime')
  environment.NODE_PATH = join(ROOT, 'node_modules')
  const child = spawn(require('electron'), [output], {
    cwd: ROOT,
    env: environment,
    windowsHide: true
  })
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  const timeout = setTimeout(() => child.kill(), liveAgent ? 300_000 : 120_000)
  const result = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
  clearTimeout(timeout)
  if (result.signal) throw new Error(`Native browser smoke terminated by ${result.signal}`)
  if (result.code !== 0) throw new Error(`Native browser smoke exited with status ${result.code}`)
  return stdout
}

async function main() {
  if (liveAgent && !process.env.SIDEKICK_AGENT_EVAL_API_KEY)
    throw new Error('A process-scoped evaluation key is required')
  const bundleRoot = mkdtempSync(join(tmpdir(), 'sidekick-native-browser-bundle-'))
  const output = join(bundleRoot, 'smoke.cjs')
  try {
    buildSync({
      entryPoints: [ENTRY],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
      ...(liveAgent || reliability
        ? {
            packages: 'external',
            loader: { '.md': 'text' },
            banner: {
              js: `require = require('node:module').createRequire(${JSON.stringify(join(ROOT, 'package.json'))});`
            }
          }
        : {}),
      logLevel: 'silent'
    })
    const stdout = await runElectron(output)
    const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith(RESULT_PREFIX))
    if (!resultLine) throw new Error('Native browser smoke did not emit a structured result')
    const result = JSON.parse(resultLine.slice(RESULT_PREFIX.length))
    if (reliability)
      console.log(
        `Browser reliability: ${result.passed}/${result.count} verified cases, ${result.elapsedMs} ms.`
      )
    else if (liveAgent)
      console.log(
        `Live browser agent passed: ${result.toolCalls} tool calls, ${result.elapsedMs} ms; exact form and visual code verified.`
      )
    else
      console.log(
        `Native browser smoke passed: ${result.semanticNodeCount} semantic nodes, ${result.screenshotBytes} screenshot bytes, ${result.popupTabs} managed tabs.`
      )
  } finally {
    removeBundleRoot(bundleRoot)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
