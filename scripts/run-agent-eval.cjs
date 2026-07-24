const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const {
  loadAgentEvalEnvironment,
  resolveAgentEvalEnvironment,
  warnAboutLocalEnvironment
} = require('./agent-eval-env.cjs')

warnAboutLocalEnvironment(loadAgentEvalEnvironment())
const evaluation = resolveAgentEvalEnvironment()

const suite = process.argv.includes('--verification')
  ? 'verification'
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

const runner = join(__dirname, 'run-vitest.cjs')
const vitestArgs = [runner, 'src/main/evals/agentHarness.live.test.ts']
if (suite === 'verification') vitestArgs.push('-t', 'production completion guard')
const result = spawnSync(process.execPath, vitestArgs, {
  stdio: 'inherit',
  env: {
    ...process.env,
    SIDEKICK_AGENT_EVAL_RUN: '1',
    SIDEKICK_AGENT_EVAL_SUITE: suite,
    SIDEKICK_AGENT_EVAL_API_KEY: evaluation.apiKey,
    SIDEKICK_AGENT_EVAL_PROVIDER_KIND: evaluation.providerKind,
    SIDEKICK_AGENT_EVAL_URL: evaluation.url,
    SIDEKICK_AGENT_EVAL_MODEL: evaluation.model
  }
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
