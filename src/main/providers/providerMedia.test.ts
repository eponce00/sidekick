import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProviderChatRequest } from '../../shared/providerRuntime'
import {
  MAX_PROVIDER_TOOL_MEDIA_ATTACHMENTS,
  materializeProviderRequestMedia
} from './providerRuntime'

function requestWithFile(path: string): ProviderChatRequest {
  return {
    target: { providerKind: 'litellm', model: 'vision-model' },
    purpose: 'continuation',
    messages: [
      {
        role: 'tool',
        tool_call_id: 'observe-1',
        content: 'Captured viewport.',
        media: [
          {
            type: 'image',
            mimeType: 'image/png',
            source: { type: 'file', path }
          }
        ]
      }
    ]
  }
}

describe('provider media materialization', () => {
  it('resolves a durable absolute file reference only in the provider request copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-provider-media-'))
    const path = join(root, 'viewport.png')
    try {
      await writeFile(path, Buffer.from([0, 1, 2, 3]))
      const original = requestWithFile(path)
      const materialized = await materializeProviderRequestMedia(original)

      expect(original.messages[0].media?.[0].source).toEqual({ type: 'file', path })
      expect(materialized.messages[0].media?.[0].source).toEqual({
        type: 'data_url',
        dataUrl: 'data:image/png;base64,AAECAw=='
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects relative file references at the I/O boundary', async () => {
    await expect(materializeProviderRequestMedia(requestWithFile('viewport.png'))).rejects.toThrow(
      'must be absolute'
    )
  })

  it('degrades expired historical artifacts to text instead of failing a continuation', async () => {
    const missing = join(tmpdir(), 'sidekick-expired-browser-artifact.png')
    const materialized = await materializeProviderRequestMedia(requestWithFile(missing))

    expect(materialized.messages[0].media).toBeUndefined()
    expect(materialized.messages[0].content).toContain(
      '[1 historical visual artifact no longer available.]'
    )
  })

  it('keeps only the newest bounded tool images in an inference request', async () => {
    const request: ProviderChatRequest = {
      target: { providerKind: 'litellm', model: 'vision-model' },
      purpose: 'continuation',
      messages: [0, 1, 2].map((index) => ({
        role: 'tool',
        tool_call_id: `observe-${index}`,
        content: `Observation ${index}`,
        media: [
          {
            type: 'image' as const,
            mimeType: 'image/png' as const,
            source: { type: 'data_url' as const, dataUrl: `data:image/png;base64,AAA${index}` }
          }
        ]
      }))
    }

    const materialized = await materializeProviderRequestMedia(request)
    expect(MAX_PROVIDER_TOOL_MEDIA_ATTACHMENTS).toBe(2)
    expect(materialized.messages.map((message) => message.media?.length ?? 0)).toEqual([0, 1, 1])
    expect(request.messages.map((message) => message.media?.length ?? 0)).toEqual([1, 1, 1])
  })
})
