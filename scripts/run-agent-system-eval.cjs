const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const { loadAgentEvalEnvironment, warnAboutLocalEnvironment } = require('./agent-eval-env.cjs')

warnAboutLocalEnvironment(loadAgentEvalEnvironment())

const localUrl = process.env.SIDEKICK_LLM_EVAL_URL || 'http://127.0.0.1:1234/v1'
const localModel = process.env.SIDEKICK_LLM_EVAL_MODEL || 'local-loaded-model'
const localKey = process.env.SIDEKICK_LLM_EVAL_API_KEY?.trim()
const openRouterKey = process.env.SIDEKICK_OPENROUTER_EVAL_API_KEY?.trim()
const target = process.env.SIDEKICK_AGENT_EVAL_TARGET?.trim() || 'auto'

async function modelIsAvailable(endpoint, apiKey, model) {
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, '')}/models`, {
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) return false
    const body = await response.json()
    return Array.isArray(body?.data) && body.data.some((entry) => entry?.id === model)
  } catch {
    return false
  }
}

function run(script, env = process.env) {
  const result = spawnSync(process.execPath, [join(__dirname, script)], {
    stdio: 'inherit',
    env: { ...env }
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

async function main() {
  if (!['auto', 'litellm', 'openrouter'].includes(target)) {
    throw new Error('SIDEKICK_AGENT_EVAL_TARGET must be auto, litellm, or openrouter')
  }
  if (process.env.SIDEKICK_AGENT_EVAL_API_KEY?.trim()) {
    console.info('[agent-system-eval] using the explicitly configured evaluation target')
    process.exit(run('run-agent-eval.cjs'))
  }

  if (
    target !== 'openrouter' &&
    localKey &&
    (await modelIsAvailable(localUrl, localKey, localModel))
  ) {
    console.info(
      '[agent-system-eval] local LiteLLM model is available; running it as authoritative'
    )
    process.exit(
      run('run-agent-eval.cjs', {
        ...process.env,
        SIDEKICK_AGENT_EVAL_API_KEY: localKey,
        SIDEKICK_AGENT_EVAL_URL: localUrl,
        SIDEKICK_AGENT_EVAL_MODEL: process.env.SIDEKICK_AGENT_EVAL_MODEL || localModel,
        SIDEKICK_AGENT_EVAL_PROVIDER_KIND: 'litellm'
      })
    )
  }

  if (target === 'litellm') {
    throw new Error('The selected LiteLLM evaluation target is unavailable')
  }

  if (!openRouterKey) {
    console.error(
      '[agent-system-eval] local LiteLLM is unavailable and SIDEKICK_OPENROUTER_EVAL_API_KEY is not configured'
    )
    process.exit(1)
  }
  console.info('[agent-system-eval] local LiteLLM is unavailable; activating OpenRouter fallback')
  process.exit(
    run('run-agent-eval.cjs', {
      ...process.env,
      SIDEKICK_AGENT_EVAL_API_KEY: openRouterKey,
      SIDEKICK_AGENT_EVAL_URL: 'https://openrouter.ai/api/v1',
      SIDEKICK_AGENT_EVAL_MODEL:
        process.env.SIDEKICK_AGENT_EVAL_MODEL ||
        process.env.SIDEKICK_OPENROUTER_EVAL_MODEL ||
        'poolside/laguna-s-2.1:free',
      SIDEKICK_AGENT_EVAL_PROVIDER_KIND: 'openrouter'
    })
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
