import { createCanvas } from '@napi-rs/canvas'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { imageHeader } from '../../shared/imageContent'
import { providerImageProfile } from '../../shared/imagePreparation'
import type { ProviderChatRequest } from '../../shared/providerRuntime'
import { materializeProviderRequestMedia } from './providerRuntime'

/** A real image, distinct for each shade, since unreadable images are left out. */
function png(shade: number, width = 4, height = 4): Buffer {
  const surface = createCanvas(width, height)
  const context = surface.getContext('2d')
  context.fillStyle = `rgb(${shade}, ${shade}, ${shade})`
  context.fillRect(0, 0, width, height)
  return surface.encodeSync('png')
}

const pngUrl = (shade: number): string => `data:image/png;base64,${png(shade).toString('base64')}`

const LITELLM_IMAGES = providerImageProfile('litellm').maxImages

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
      const bytes = png(10)
      await writeFile(path, bytes)
      const original = requestWithFile(path)
      const materialized = await materializeProviderRequestMedia(original)

      expect(original.messages[0].media?.[0].source).toEqual({ type: 'file', path })
      expect(materialized.messages[0].media?.[0].source).toEqual({
        type: 'data_url',
        dataUrl: `data:image/png;base64,${bytes.toString('base64')}`
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
            source: { type: 'data_url' as const, dataUrl: pngUrl(index) }
          }
        ]
      }))
    }

    const materialized = await materializeProviderRequestMedia(request)
    expect(LITELLM_IMAGES).toBe(2)
    expect(materialized.messages.map((message) => message.media?.length ?? 0)).toEqual([0, 1, 1])
    expect(request.messages.map((message) => message.media?.length ?? 0)).toEqual([1, 1, 1])
  })

  it('shares one image budget between user attachments and browser tool screenshots', async () => {
    const request: ProviderChatRequest = {
      target: { providerKind: 'litellm', model: 'vision-model' },
      purpose: 'continuation',
      messages: [
        {
          role: 'user',
          content: 'Fix what is shown here.',
          images: [pngUrl(200)]
        },
        ...[0, 1].map((index) => ({
          role: 'tool',
          tool_call_id: `observe-${index}`,
          content: `Observation ${index}`,
          media: [
            {
              type: 'image' as const,
              mimeType: 'image/png' as const,
              source: { type: 'data_url' as const, dataUrl: pngUrl(index) }
            }
          ]
        }))
      ]
    }

    const materialized = await materializeProviderRequestMedia(request)

    expect(materialized.messages[0].images).toEqual([pngUrl(200)])
    expect(materialized.messages.map((message) => message.media?.length ?? 0)).toEqual([0, 0, 1])
    expect(
      materialized.messages.reduce(
        (count, message) => count + (message.images?.length ?? 0) + (message.media?.length ?? 0),
        0
      )
    ).toBe(LITELLM_IMAGES)
    expect(request.messages[1].media).toHaveLength(1)
  })

  it('uses spare capacity for the next-newest explicit attachment', async () => {
    const request: ProviderChatRequest = {
      target: { providerKind: 'litellm', model: 'vision-model' },
      purpose: 'continuation',
      messages: [
        { role: 'user', content: 'Earlier', images: [pngUrl(1)] },
        { role: 'assistant', content: 'Continue.' },
        { role: 'user', content: 'Latest', images: [pngUrl(2)] }
      ]
    }

    const materialized = await materializeProviderRequestMedia(request)

    expect(materialized.messages[0].images).toEqual([pngUrl(1)])
    expect(materialized.messages[2].images).toEqual([pngUrl(2)])
  })

  it('sends every attached image to a provider that takes more than two', async () => {
    const images = [1, 2, 3, 4].map(pngUrl)
    const request: ProviderChatRequest = {
      target: { providerKind: 'anthropic', model: 'claude' },
      purpose: 'continuation',
      messages: [{ role: 'user', content: 'Compare these.', images }]
    }

    const anthropic = await materializeProviderRequestMedia(request)
    expect(anthropic.messages[0].images).toEqual(images)
    const local = await materializeProviderRequestMedia({
      ...request,
      target: { providerKind: 'lmstudio', model: 'qwen3-vl' }
    })
    expect(local.messages[0].images).toEqual(images.slice(0, 2))
  })

  it('fits a large attachment to the provider while the stored message keeps it', async () => {
    const original = `data:image/png;base64,${png(120, 3000, 1500).toString('base64')}`
    const request: ProviderChatRequest = {
      target: { providerKind: 'anthropic', model: 'claude' },
      purpose: 'continuation',
      messages: [{ role: 'user', content: 'What is this?', images: [original] }]
    }

    const materialized = await materializeProviderRequestMedia(request)
    const sent = Buffer.from(materialized.messages[0].images![0].split(',')[1], 'base64')
    expect(imageHeader(sent)).toMatchObject({ width: 2000, height: 1000 })
    expect(materialized.messages[0].content).toContain('resized from 3000×1500 to 2000×1000')
    expect(request.messages[0].images).toEqual([original])
  })

  it('keeps a file-backed viewport screenshot at its own size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-provider-media-'))
    const path = join(root, 'viewport.png')
    try {
      await writeFile(path, png(30, 2400, 1350))
      const request = requestWithFile(path)
      request.target = { providerKind: 'lmstudio', model: 'qwen3-vl' }
      request.messages[0].media![0].keepDimensions = true
      const materialized = await materializeProviderRequestMedia(request)
      const attachment = materialized.messages[0].media![0]
      expect(attachment.source.type).toBe('data_url')
      const dataUrl = attachment.source.type === 'data_url' ? attachment.source.dataUrl : ''
      expect(imageHeader(Buffer.from(dataUrl.split(',')[1], 'base64'))).toMatchObject({
        width: 2400,
        height: 1350
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
