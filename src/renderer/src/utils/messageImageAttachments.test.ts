// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { clipboardImageFiles, fileToMessageImage } from './messageImageAttachments'

describe('message image attachments', () => {
  it('takes only image files from clipboard items', () => {
    const image = new File(['png'], 'clipboard.png', { type: 'image/png' })
    const text = new File(['text'], 'notes.txt', { type: 'text/plain' })
    const items = [
      { kind: 'file', type: 'image/png', getAsFile: () => image },
      { kind: 'file', type: 'text/plain', getAsFile: () => text },
      { kind: 'string', type: 'text/plain', getAsFile: vi.fn() }
    ] as unknown as DataTransferItem[]

    expect(clipboardImageFiles(items)).toEqual([image])
  })

  it('creates the same durable attachment shape used by file selection', async () => {
    const image = new File(['png'], 'screenshot.png', { type: 'image/png' })
    const attachment = await fileToMessageImage(image)

    expect(attachment).toMatchObject({ name: 'screenshot.png', mimeType: 'image/png' })
    expect(attachment.id).toBeTruthy()
    expect(attachment.dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('rejects unsupported or oversized files', async () => {
    await expect(
      fileToMessageImage(new File(['text'], 'notes.txt', { type: 'text/plain' }))
    ).rejects.toThrow('PNG, JPEG, WebP, or GIF')
  })
})
