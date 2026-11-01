const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const {
  loadAgentEvalEnvironment,
  resolveAgentEvalEnvironment,
  warnAboutLocalEnvironment
} = require('./agent-eval-env.cjs')

warnAboutLocalEnvironment(loadAgentEvalEnvironment())
const evaluation = resolveAgentEvalEnvironment()

const suite = process.argv.includes('--replay')
  ? 'replay'
  : process.argv.includes('--verification')
    ? 'verification'
    : process.argv.includes('--visual')
      ? 'visual'
      : process.argv.includes('--quick')
        ? 'quick'
        : process.env.SIDEKICK_AGENT_EVAL_SUITE || 'full'

if (!evaluation.apiKey) {
  console.error(
    'No agent evaluation credential is configured. Set SIDEKICK_LLM_EVAL_API_KEY, SIDEKICK_OPENROUTER_EVAL_API_KEY, or the one-run SIDEKICK_AGENT_EVAL_API_KEY override in the process environment or .env.agent-eval.local.'
  )
  process.exit(1)
}

console.info(`[agent-eval] using ${evaluation.credentialSource}`)

function revision() {
  const git = (...args) =>
    spawnSync('git', args, { cwd: join(__dirname, '..'), encoding: 'utf8' }).stdout?.trim() || ''
  const head = git('rev-parse', '--short=8', 'HEAD')
  return head && git('status', '--porcelain') ? `${head}+changes` : head || 'local'
}

const runner = join(__dirname, 'run-vitest.cjs')
const vitestArgs = [
  runner,
  suite === 'replay'
    ? 'src/main/evals/replay.live.test.ts'
    : 'src/main/evals/agentHarness.live.test.ts'
]
if (suite === 'verification') vitestArgs.push('-t', 'production completion guard')
if (suite === 'visual') vitestArgs.push('-t', 'self-contained SVG visual')
const result = spawnSync(process.execPath, vitestArgs, {
  stdio: 'inherit',
  env: {
    ...process.env,
    SIDEKICK_AGENT_EVAL_RUN: '1',
    SIDEKICK_AGENT_EVAL_SUITE: suite,
    SIDEKICK_AGENT_EVAL_API_KEY: evaluation.apiKey,
    SIDEKICK_AGENT_EVAL_PROVIDER_KIND: evaluation.providerKind,
    SIDEKICK_AGENT_EVAL_URL: evaluation.url,
    SIDEKICK_AGENT_EVAL_MODEL: evaluation.model,
    // Reports from two branches name the revision each one measured.
    SIDEKICK_AGENT_EVAL_REVISION: revision()
  }
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
