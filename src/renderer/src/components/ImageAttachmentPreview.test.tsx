// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { providerImageProfile } from '../../../shared/imagePreparation'
import { ImageAttachmentPreview } from './ImageAttachmentPreview'

describe('ImageAttachmentPreview', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.querySelector('.image-lightbox')?.remove()
    container.remove()
  })

  it('opens images in an in-app lightbox and closes with Escape', async () => {
    await act(async () => {
      root.render(
        <ImageAttachmentPreview
          image={{
            id: 'image-1',
            name: 'clipboard.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,AAAA'
          }}
        />
      )
    })

    expect(container.querySelector('.image-attachment-expand')).not.toBeNull()

    await act(async () => {
      ;(container.querySelector('[aria-label="Open clipboard.png"]') as HTMLButtonElement).click()
    })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('clipboard.png')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('says quietly when the selected model will receive a smaller copy', async () => {
    const image = {
      id: 'image-1',
      name: 'screen.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AAAA'
    }
    const loadAt = async (width: number, height: number): Promise<HTMLButtonElement> => {
      const element = container.querySelector('img') as HTMLImageElement
      Object.defineProperty(element, 'naturalWidth', { value: width, configurable: true })
      Object.defineProperty(element, 'naturalHeight', { value: height, configurable: true })
      await act(async () => {
        element.dispatchEvent(new Event('load'))
      })
      return container.querySelector('.image-attachment-preview') as HTMLButtonElement
    }

    await act(async () => {
      root.render(
        <ImageAttachmentPreview image={image} sendProfile={providerImageProfile('anthropic')} />
      )
    })
    const button = await loadAt(5120, 2880)
    expect(button.title).toBe(
      'Open screen.png\nThis model receives a 2000 × 1125 copy. The original stays in the chat.'
    )
    await act(async () => button.click())
    expect(document.querySelector('.image-lightbox-note')?.textContent).toContain('2000 × 1125')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect((await loadAt(800, 600)).title).toBe('Open screen.png')
  })
})
