const { app, safeStorage } = require('electron')
const { readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

function selectedProvider(config) {
  const settings = config.settings || {}
  const selectedId = String(settings.selectedModel || '')
  const pinned = (config.pinnedModels || []).find((candidate) => candidate.id === selectedId)
  const instanceId = pinned?.providerInstanceId
  const model = pinned?.providerModelId || pinned?.name
  const instance = (settings.providerInstances || []).find(
    (candidate) => candidate.id === instanceId
  )
  if (!instance || !model) {
    throw new Error('The selected SideKick model is not backed by a configured provider instance')
  }
  return { settings, instance, model }
}

async function main() {
  const sidekickUserData = join(app.getPath('appData'), 'sidekick')
  app.setPath('userData', sidekickUserData)
  await app.whenReady()

  const config = JSON.parse(readFileSync(join(sidekickUserData, 'config.json'), 'utf8'))
  const { settings, instance, model } = selectedProvider(config)
  const encoded = settings.__encryptedProviderSecrets?.[instance.id]
  if (!encoded || !safeStorage.isEncryptionAvailable()) {
    throw new Error('The selected provider credential is unavailable in protected storage')
  }
  const apiKey = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  const providerKind = /openrouter/i.test(String(instance.baseUrl || '')) ? 'openrouter' : 'litellm'
  const suiteArgs = process.argv
    .slice(2)
    .filter((argument) =>
      ['--quick', '--verification', '--visual', '--comprehensive'].includes(argument)
    )
  const comprehensive = suiteArgs.includes('--comprehensive')
  const runner = comprehensive
    ? join(__dirname, 'run-agent-comprehensive-eval.cjs')
    : join(__dirname, 'run-agent-eval.cjs')
  const runnerArgs = comprehensive ? [] : suiteArgs
  const child = spawnSync(process.execPath, [runner, ...runnerArgs], {
    cwd: join(__dirname, '..'),
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SIDEKICK_AGENT_EVAL_API_KEY: apiKey,
      SIDEKICK_AGENT_EVAL_PROVIDER_KIND: providerKind,
      SIDEKICK_AGENT_EVAL_URL: instance.baseUrl,
      SIDEKICK_AGENT_EVAL_MODEL: model
    }
  })
  if (child.error) throw child.error
  app.exit(child.status ?? 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  app.exit(1)
})
