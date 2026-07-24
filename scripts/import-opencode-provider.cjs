const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const identity = require('../src/shared/productIdentity.json')

async function main() {
  const [, , configPath, providerId] = process.argv
  if (!configPath || !providerId) {
    throw new Error(
      'Usage: electron scripts/import-opencode-provider.cjs <opencode-config> <provider-id>'
    )
  }

  app.setName(identity.productName)
  await app.whenReady()
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-backed secret encryption is unavailable')
  }

  const opencode = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const provider = opencode.provider?.[providerId]
  const endpoint = provider?.options?.baseURL
  const apiKey = provider?.options?.apiKey
  if (typeof endpoint !== 'string' || !endpoint) throw new Error('Provider has no baseURL')
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('Provider has no apiKey')

  const userData = app.getPath('userData')
  const target = path.join(userData, 'config.json')
  fs.mkdirSync(userData, { recursive: true })
  const config = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {}
  const settings =
    config.settings && typeof config.settings === 'object' ? { ...config.settings } : {}
  const encrypted =
    settings.__encryptedSecrets && typeof settings.__encryptedSecrets === 'object'
      ? { ...settings.__encryptedSecrets }
      : {}
  const encryptedProviderSecrets =
    settings.__encryptedProviderSecrets && typeof settings.__encryptedProviderSecrets === 'object'
      ? { ...settings.__encryptedProviderSecrets }
      : {}

  settings.lmStudioEndpoint = endpoint.replace(/\/+$/, '')
  delete encrypted.lmStudioApiKey
  settings.__encryptedSecrets = encrypted
  delete settings.lmStudioApiKey

  const instanceId = `opencode-${providerId}`.replace(/[^a-zA-Z0-9_-]/g, '-')
  const configuredProviderModels = Object.entries(provider.models || {}).map(
    ([modelId, model]) => ({
      id: modelId,
      name: typeof model?.name === 'string' ? model.name : modelId,
      enabled: true
    })
  )
  const configuredModels = configuredProviderModels.map((model) => ({
    id: `lmstudio:${instanceId}/${model.id}`,
    name: model.name,
    provider: 'lmstudio',
    providerInstanceId: instanceId,
    providerInstanceName: provider.name || providerId,
    providerModelId: model.id
  }))
  const selected =
    typeof opencode.model === 'string' && opencode.model.startsWith(`${providerId}/`)
      ? opencode.model.slice(providerId.length + 1)
      : null
  if (selected) settings.selectedModel = `lmstudio:${instanceId}/${selected}`

  encryptedProviderSecrets[instanceId] = safeStorage.encryptString(apiKey).toString('base64')
  settings.__encryptedProviderSecrets = encryptedProviderSecrets
  const providerInstances = Array.isArray(settings.providerInstances)
    ? settings.providerInstances
    : []
  settings.providerInstances = [
    ...providerInstances.filter((instance) => instance?.id !== instanceId),
    {
      id: instanceId,
      name: provider.name || providerId,
      type: 'openai-compatible',
      preset: 'generic',
      enabled: true,
      baseUrl: endpoint.replace(/\/+$/, ''),
      modelSource: 'discover',
      models: configuredProviderModels
    }
  ]

  const existingModels = Array.isArray(config.pinnedModels) ? config.pinnedModels : []
  const importedIds = new Set(configuredModels.map((model) => model.id))
  const importedModelIds = new Set(configuredProviderModels.map((model) => model.id))
  config.settings = settings
  config.pinnedModels = [
    ...existingModels.filter((model) => {
      if (importedIds.has(model?.id)) return false
      if (model?.provider !== 'lmstudio') return true
      const legacyModelId =
        model.providerModelId || String(model.id || '').replace(/^lmstudio:/, '')
      return !importedModelIds.has(legacyModelId)
    }),
    ...configuredModels
  ]

  const temporary = `${target}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, target)
  fs.chmodSync(target, 0o600)
  console.log(`Imported ${configuredModels.length} models into ${target}`)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(() => app.quit())
