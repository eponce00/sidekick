const { spawn, spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { delimiter, join, resolve, sep } = require('node:path')
const { build } = require('esbuild')

const ROOT = resolve(__dirname, '..')
const ENTRY = join(ROOT, 'scripts', 'agent-comprehensive-eval.entry.ts')
const RESULT_PREFIX = 'SIDEKICK_COMPREHENSIVE_EVAL='
const electronRoot = join(ROOT, 'node_modules', 'electron', 'dist')
const electronExecutable =
  process.platform === 'darwin'
    ? join(electronRoot, 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : process.platform === 'win32'
      ? join(electronRoot, 'electron.exe')
      : join(electronRoot, 'electron')
let activeChild
let activeEvaluationRoot

function requiredEnvironment(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function removeEvaluationRoot(root) {
  const expectedTemp = resolve(tmpdir())
  const resolvedRoot = resolve(root)
  if (
    resolvedRoot.startsWith(`${expectedTemp}${sep}`) &&
    resolvedRoot.split(sep).at(-1).startsWith('sidekick-comprehensive-eval-')
  ) {
    rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
  }
}

function terminateChildTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    return
  }
  child.kill('SIGTERM')
}

function cleanupInterruptedRun(exitCode) {
  terminateChildTree(activeChild)
  if (activeEvaluationRoot) removeEvaluationRoot(activeEvaluationRoot)
  process.exit(exitCode)
}

process.once('SIGINT', () => cleanupInterruptedRun(130))
process.once('SIGTERM', () => cleanupInterruptedRun(143))

async function runElectron(output, evaluationRoot) {
  const environment = {
    ...process.env,
    SIDEKICK_COMPREHENSIVE_EVAL_ROOT: join(evaluationRoot, 'scenario'),
    NODE_PATH: [join(ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(delimiter)
  }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(electronExecutable, [output], {
    cwd: ROOT,
    env: environment,
    windowsHide: true
  })
  activeChild = child
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  const timeout = setTimeout(() => terminateChildTree(child), 25 * 60_000)
  const result = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
  clearTimeout(timeout)
  activeChild = undefined
  if (result.signal) throw new Error(`Comprehensive eval terminated by ${result.signal}`)
  if (result.code !== 0) throw new Error(`Comprehensive eval exited with status ${result.code}`)
  return stdout
}

async function main() {
  requiredEnvironment('SIDEKICK_AGENT_EVAL_API_KEY')
  requiredEnvironment('SIDEKICK_AGENT_EVAL_URL')
  requiredEnvironment('SIDEKICK_AGENT_EVAL_MODEL')
  const evaluationRoot = mkdtempSync(join(tmpdir(), 'sidekick-comprehensive-eval-'))
  activeEvaluationRoot = evaluationRoot
  const output = join(evaluationRoot, 'comprehensive-eval.cjs')
  try {
    await build({
      entryPoints: [ENTRY],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
      loader: { '.md': 'text' },
      plugins: [
        {
          name: 'absolute-native-dependencies',
          setup(build) {
            build.onResolve({ filter: /^(?:better-sqlite3|jsdom)$/ }, (args) => ({
              path: require.resolve(args.path),
              external: true
            }))
          }
        }
      ],
      logLevel: 'silent'
    })
    const stdout = await runElectron(output, evaluationRoot)
    const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith(RESULT_PREFIX))
    if (!resultLine) throw new Error('Comprehensive eval did not emit a structured result')
    const result = JSON.parse(resultLine.slice(RESULT_PREFIX.length))
    console.log(
      `Comprehensive agent eval passed: ${result.turns} turns, ${result.completedToolCalls} tool calls, ${result.uniqueTools.length} tool types, ${result.screenshots} screenshots.`
    )
  } finally {
    removeEvaluationRoot(evaluationRoot)
    activeEvaluationRoot = undefined
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
