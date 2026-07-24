const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const { loadAgentEvalEnvironment, warnAboutLocalEnvironment } = require('./agent-eval-env.cjs')

warnAboutLocalEnvironment(loadAgentEvalEnvironment())

if (!process.env.SIDEKICK_OPENROUTER_EVAL_API_KEY?.trim()) {
  console.error(
    'SIDEKICK_OPENROUTER_EVAL_API_KEY is required. Keep it in the process environment or GitHub Actions secret; never commit it.'
  )
  process.exit(1)
}

const runner = join(__dirname, 'run-vitest.cjs')
const result = spawnSync(
  process.execPath,
  [runner, 'src/main/evals/openRouterModelMatrix.live.test.ts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      SIDEKICK_OPENROUTER_EVAL_RUN: '1'
    }
  }
)

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
