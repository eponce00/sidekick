// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageMarkdown } from './MessageMarkdown'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('MessageMarkdown rich media', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.querySelectorAll('.message-image-lightbox').forEach((node) => node.remove())
    container.remove()
  })

  it('keeps mixed image-and-copy paragraphs in normal document flow', async () => {
    await act(async () => {
      root.render(
        <div className="message-content">
          <MessageMarkdown content="![One](https://a.test/1.jpg) caption outside the image" />
        </div>
      )
    })

    expect(container.querySelector('.message-image-gallery')).toBeNull()
    expect(container.querySelector('.doc-img')?.getAttribute('alt')).toBe('One')
    expect(container.textContent).toContain('caption outside the image')
  })

  it('lays paired images out as one gallery and opens keyboard-accessible preview', async () => {
    await act(async () => {
      root.render(
        <div className="message-content">
          <MessageMarkdown
            content={
              '![Storefront](https://img.test/front.jpg)\n![Pastries](https://img.test/food.jpg)'
            }
          />
        </div>
      )
    })

    const gallery = container.querySelector('.message-image-gallery')
    const tiles = container.querySelectorAll<HTMLButtonElement>('.message-image-tile')
    expect(gallery?.getAttribute('data-count')).toBe('2')
    expect(tiles).toHaveLength(2)
    expect(container.querySelectorAll('.message-image-gallery img')).toHaveLength(2)

    await act(async () => tiles[0].click())
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toContain(
      'Storefront'
    )
    expect(document.querySelector('.message-image-lightbox-stage img')?.getAttribute('alt')).toBe(
      'Storefront'
    )

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })))
    expect(document.querySelector('.message-image-lightbox-stage img')?.getAttribute('alt')).toBe(
      'Pastries'
    )

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('bounds large galleries while keeping every image available in the preview', async () => {
    const markdown = Array.from(
      { length: 6 },
      (_, index) => `![Image ${index + 1}](https://img.test/${index + 1}.jpg)`
    ).join('\n')
    await act(async () => {
      root.render(
        <div className="message-content">
          <MessageMarkdown content={markdown} />
        </div>
      )
    })

    expect(container.querySelectorAll('.message-image-tile')).toHaveLength(4)
    expect(container.querySelector('.message-image-more')?.textContent).toBe('+2')
    expect(container.querySelector('.message-image-gallery')?.getAttribute('aria-label')).toBe(
      '6 shared images'
    )
  })

  it('shows a quiet fallback when a remote image fails', async () => {
    await act(async () => {
      root.render(
        <div className="message-content">
          <MessageMarkdown content="![Unavailable](https://img.test/missing.jpg)" />
        </div>
      )
    })
    const image = container.querySelector('.message-image-tile img') as HTMLImageElement
    await act(async () => image.dispatchEvent(new Event('error')))
    expect(container.querySelector('.message-image-error')?.textContent).toContain(
      'Image unavailable'
    )
  })

  it('defers streamed images until the response is stable', async () => {
    const content = '![Storefront](https://img.test/front.jpg)'
    await act(async () => {
      root.render(<MessageMarkdown content={content} isStreaming />)
    })
    expect(container.querySelector('img')).toBeNull()

    await act(async () => {
      root.render(<MessageMarkdown content={`${content}\n\nThe description is still streaming.`} />)
    })
    expect(container.querySelector('.message-image-gallery img')).not.toBeNull()
  })

  it('preserves loaded media nodes when surrounding Markdown changes', async () => {
    const images =
      '![Storefront](https://img.test/front.jpg)\n![Pastries](https://img.test/food.jpg)'
    await act(async () => root.render(<MessageMarkdown content={images} />))
    const firstImage = container.querySelector('.message-image-gallery img')

    await act(async () =>
      root.render(<MessageMarkdown content={`${images}\n\nMore streamed copy arrived.`} />)
    )
    expect(container.querySelector('.message-image-gallery img')).toBe(firstImage)
  })

  it('promotes standalone map destinations into an expandable interactive card', async () => {
    await act(async () => {
      root.render(
        <div className="message-content">
          <MessageMarkdown content="📍 [Open in Google Maps](https://www.google.com/maps/search/?api=1&query=Versailles%2C+Miami)" />
        </div>
      )
    })
    const card = container.querySelector('.message-map-card')
    const link = container.querySelector('.message-map-address') as HTMLAnchorElement
    expect(card?.textContent).toContain('Versailles, Miami')
    expect(container.querySelector('.message-map-surface')).not.toBeNull()
    expect(container.querySelector('.message-map-toggle')).toBeNull()
    expect(link.target).toBe('_blank')
    expect(link.rel).toContain('noreferrer')
    expect(container.querySelector('.message-map-external')).toBeNull()
  })

  it('keeps map links inline when they are part of a prose paragraph', async () => {
    await act(async () => {
      root.render(
        <div className="message-content">
          <MessageMarkdown content="Meet at [the park](https://maps.apple.com/?q=Bayfront+Park&ll=25.775,-80.186) before sunset." />
        </div>
      )
    })
    expect(container.querySelector('.message-map-card')).toBeNull()
    expect(container.querySelector('.markdown-map-link')?.textContent).toContain('the park')
  })

  it('keeps artifact rendering available through the shared Markdown boundary', async () => {
    const onArtifactResult = vi.fn()
    await act(async () => {
      root.render(
        <div className="message-content">
          <MessageMarkdown content="`const answer = 42`" onArtifactResult={onArtifactResult} />
        </div>
      )
    })
    expect(container.querySelector('code')?.textContent).toContain('const answer = 42')
  })
})
