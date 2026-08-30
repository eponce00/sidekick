// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
})
