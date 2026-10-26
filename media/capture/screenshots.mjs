// Takes the README's still screenshots from the real app: Settings → Providers, with local model
// servers stood in for by fake ones on loopback, so the page shows real connections and models
// without anyone's account. Run `npm run build` in the repository first.
import { createServer } from 'node:http'
import { join } from 'node:path'
import { launchApp, ROOT, WINDOW } from './app.mjs'
import { startFakeModel } from './fake-model.mjs'

const OUT = join(ROOT, 'docs', 'assets', 'screenshots')

/** Answers the model-list requests of Ollama's own API and of OpenAI-compatible servers. */
async function startModelServer(models, port = 0) {
  const server = createServer(async (request, response) => {
    const url = request.url ?? ''
    const json = (body) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (url.endsWith('/api/tags'))
      return json({
        models: models.map((m) => ({
          name: m.id,
          model: m.id,
          size: 5_200_000_000,
          details: { family: m.family, parameter_size: m.size, quantization_level: 'Q4_K_M' }
        }))
      })
    if (url.endsWith('/api/version')) return json({ version: '0.12.6' })
    if (url.endsWith('/api/show')) {
      let body = ''
      for await (const chunk of request) body += chunk
      const shown = models.find((m) => body.includes(m.id)) ?? models[0]
      return json({
        capabilities: ['completion', 'tools', 'thinking'],
        model_info: {
          'general.architecture': shown.family,
          [`${shown.family}.context_length`]: shown.context
        }
      })
    }
    if (url.endsWith('/models') || url.endsWith('/model/info'))
      return json({
        object: 'list',
        data: models.map((m) => ({ id: m.id, object: 'model', context_length: m.context }))
      })
    response.writeHead(404)
    response.end()
  })
  await new Promise((ready) => server.listen(port, '127.0.0.1', ready))
  // On the usual port the address reads as it does on anyone's machine.
  const host = port ? 'localhost' : '127.0.0.1'
  return { url: `http://${host}:${server.address().port}`, close: () => server.close() }
}

const ollama = await startModelServer(
  [
    { id: 'qwen3:8b', family: 'qwen3', size: '8.2B', context: 40960 },
    { id: 'gemma3:12b', family: 'gemma3', size: '12.2B', context: 131072 },
    { id: 'llama3.2:3b', family: 'llama', size: '3.2B', context: 131072 }
  ],
  11434
)
const lmstudio = await startModelServer(
  [
    { id: 'qwen3-coder-30b-a3b-instruct', context: 262144 },
    { id: 'openai/gpt-oss-20b', context: 131072 }
  ],
  1234
)
const litellm = await startModelServer([
  { id: 'claude-sonnet-4-5', context: 200000 },
  { id: 'gpt-5-mini', context: 400000 }
])
const model = await startFakeModel({ model: 'sidekick-demo', scenes: {} })
const { app, page } = await launchApp({ modelUrl: model.url })

await page.evaluate(
  async ({ ollama, lmstudio, litellm }) => {
    const current = await window.api.settings.load()
    const instance = (id, name, type, preset, baseUrl, models) => ({
      id,
      name,
      type,
      ...(preset ? { preset } : {}),
      enabled: true,
      baseUrl,
      modelSource: 'discover',
      models: models.map((id) => ({ id, enabled: true }))
    })
    await window.api.settings.save({
      ...current,
      providerInstances: [
        instance('ollama-local', 'Ollama', 'ollama', null, ollama, ['qwen3:8b', 'gemma3:12b']),
        instance('lm-studio', 'LM Studio', 'openai-compatible', 'lmstudio', `${lmstudio}/v1`, [
          'qwen3-coder-30b-a3b-instruct'
        ]),
        instance('team-gateway', 'Team gateway', 'litellm', null, `${litellm}/v1`, [
          'claude-sonnet-4-5'
        ])
      ]
    })
  },
  { ollama: ollama.url, lmstudio: lmstudio.url, litellm: litellm.url }
)
await page.reload()
await page.waitForFunction(() => Boolean(window.api?.settings))
await page.waitForTimeout(1500)
await page.getByRole('button', { name: 'Settings' }).first().click()
await page.waitForTimeout(1500)
await page.getByText('Providers', { exact: true }).first().click()
await page.waitForTimeout(1200)
const openOllama = async () => {
  await page.getByText('Ollama', { exact: true }).first().click()
  await page.waitForTimeout(1200)
}
await openOllama()
// Loads the models' details from the servers, then saves them, so the page shows no pending edit.
await page
  .getByRole('button', { name: /Refresh models|Test connection/ })
  .first()
  .click()
  .catch(() => undefined)
await page.waitForTimeout(2500)
await page
  .getByRole('button', { name: 'Save changes' })
  .click()
  .catch(() => undefined)
await page.waitForTimeout(1500)
await page.getByRole('button', { name: 'Settings' }).first().click()
await page.waitForTimeout(1500)
await page.getByText('Providers', { exact: true }).first().click()
await page.waitForTimeout(1200)
await openOllama()
await page.waitForTimeout(2000)
await page.screenshot({ path: join(OUT, 'providers.png'), clip: { x: 0, y: 0, ...WINDOW } })
console.log('Saved docs/assets/screenshots/providers.png')

await app.close()
for (const server of [model, ollama, lmstudio, litellm]) server.close()
