const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const { loadAgentEvalEnvironment, warnAboutLocalEnvironment } = require('./agent-eval-env.cjs')

warnAboutLocalEnvironment(loadAgentEvalEnvironment())

if (!process.env.SIDEKICK_OPENROUTER_EVAL_API_KEY?.trim()) {
  console.error(
    'SIDEKICK_OPENROUTER_EVAL_API_KEY is required. Keep it in the process environment or .env.agent-eval.local; never commit it.'
  )
  process.exit(1)
}

// Models come from the command line, or the configured OpenRouter evaluation model.
const models = process.argv.slice(2).join(',') || process.env.SIDEKICK_OPENROUTER_EVAL_MODEL || ''
if (!models.trim()) {
  console.error(
    'Name one or more free OpenRouter models, for example nvidia/nemotron-3.5-super-vl:free.'
  )
  process.exit(1)
}

const runner = join(__dirname, 'run-vitest.cjs')
const result = spawnSync(process.execPath, [runner, 'src/main/evals/realWorld.live.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, SIDEKICK_REALWORLD_RUN: '1', SIDEKICK_REALWORLD_MODELS: models }
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
