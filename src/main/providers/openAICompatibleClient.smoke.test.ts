import { describe, expect, it } from 'vitest'
import {
  completeOpenAICompatibleChat,
  fetchOpenAICompatibleModels,
  openAICompatibleHeaders
} from './openAICompatibleClient'
import { streamOpenAICompatibleChat } from './openAIStreamingClient'
import type { ProviderStreamChunk } from '../../shared/providerRuntime'

const endpoint = process.env.SIDEKICK_PROVIDER_SMOKE_URL?.trim()
const apiKey = process.env.SIDEKICK_PROVIDER_SMOKE_API_KEY
const configuredModel = process.env.SIDEKICK_PROVIDER_SMOKE_MODEL?.trim()
const smoke = endpoint ? describe : describe.skip

smoke('real OpenAI-compatible provider smoke', () => {
  it('discovers a model and completes a minimal chat request', async () => {
    const headers = openAICompatibleHeaders(apiKey)
    const catalog = await fetchOpenAICompatibleModels(
      endpoint!,
      headers,
      fetch,
      AbortSignal.timeout(30_000)
    )
    expect(catalog.ok, catalog.error).toBe(true)
    const availableModels = catalog.data?.data.map((model) => model.id) || []
    expect(availableModels.length).toBeGreaterThan(0)

    const model = configuredModel || availableModels[0]
    expect(availableModels, `Configured model ${model} was not returned by /models`).toContain(
      model
    )

    const completion = await completeOpenAICompatibleChat(
      endpoint!,
      {
        model,
        messages: [{ role: 'user', content: 'Reply with only SIDEKICK_SMOKE_OK' }],
        max_tokens: 256,
        temperature: 0,
        reasoning_effort: 'none'
      },
      headers,
      fetch,
      AbortSignal.timeout(90_000)
    )
    expect(completion.ok, completion.error).toBe(true)
    expect(completion.data?.message.content).toContain('SIDEKICK_SMOKE_OK')

    const chunks: ProviderStreamChunk[] = []
    const streamed = await streamOpenAICompatibleChat(
      endpoint!,
      {
        model,
        messages: [{ role: 'user', content: 'Reply with only SIDEKICK_STREAM_OK' }],
        max_tokens: 256,
        temperature: 0,
        reasoning_effort: 'none'
      },
      headers,
      (chunk) => chunks.push(chunk),
      fetch,
      AbortSignal.timeout(90_000)
    )
    expect(streamed.ok, streamed.error).toBe(true)
    expect(chunks.some((chunk) => chunk.done)).toBe(true)
    expect(chunks.map((chunk) => chunk.message?.content || '').join('')).toContain(
      'SIDEKICK_STREAM_OK'
    )
  }, 190_000)
})
