// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { splitMarkdownRenderBlocks } from '../utils/markdownStreaming'
import { MessageMarkdown } from './MessageMarkdown'
import {
  subscribeWorkspaceFileView,
  type WorkspaceFileViewRequest
} from '../utils/workspaceFileViewer'

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

  it('puts a table in its own card, and draws a checklist with the app’s boxes', async () => {
    await act(async () => {
      root.render(
        <MessageMarkdown
          content={[
            '| Area | Status |',
            '| --- | --- |',
            '| Phone | Done |',
            '',
            '- [x] Typecheck',
            '- [ ] Test on iPhone'
          ].join('\n')}
        />
      )
    })

    expect(container.querySelector('.markdown-table > table td')?.textContent).toBe('Phone')
    // The browser's disabled checkboxes are replaced, and still say what they mean.
    expect(container.querySelector('input')).toBeNull()
    expect(
      [...container.querySelectorAll('.markdown-task-box')].map((box) =>
        box.getAttribute('aria-label')
      )
    ).toEqual(['Done', 'Not done'])
    expect(container.querySelector('.markdown-task-box.is-done svg')).not.toBeNull()
  })

  it('reads two prices on a line as prices, and still typesets math', async () => {
    await act(async () => {
      root.render(
        <MessageMarkdown content="Key facts: $825,000 asking, last sold 2015 for $299,500. Area: $x^2$." />
      )
    })

    expect(container.textContent).toContain('$825,000 asking, last sold 2015 for $299,500.')
    // Only the real formula is typeset.
    expect(container.querySelectorAll('.katex')).toHaveLength(1)
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

  it('keeps fenced code together while splitting stable streamed blocks', () => {
    expect(
      splitMarkdownRenderBlocks(
        'First paragraph.\n\n```ts\nconst x = 1\n\nconst y = 2\n```\n\nTail'
      )
    ).toEqual(['First paragraph.\n\n', '```ts\nconst x = 1\n\nconst y = 2\n```\n\n', 'Tail'])
  })

  it('renders block code with a language label and copy control', async () => {
    await act(async () => {
      root.render(<MessageMarkdown content={'```typescript\nconst answer = 42\n```'} />)
    })
    expect(container.querySelector('.markdown-code-language')?.textContent).toBe('typescript')
    expect(container.querySelector('[aria-label="Copy code"]')).not.toBeNull()
  })

  it('turns an inline filename into a chip only once it resolves, then opens it in the viewer', async () => {
    const resolveFileReference = vi.fn(async () => ({ ok: true, matches: ['src/main.js'] }))
    const openFileReference = vi.fn(async () => ({ ok: true, status: 'opened' as const, path: '' }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        workspace: { ...window.api?.workspace, resolveFileReference, openFileReference }
      }
    })
    const shown: WorkspaceFileViewRequest[] = []
    const unsubscribe = subscribeWorkspaceFileView((request) => shown.push(request))
    try {
      await act(async () => {
        root.render(<MessageMarkdown content="Open `main.js:12`." workspaceRoot={'C:\\project'} />)
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(resolveFileReference).toHaveBeenCalledWith('main.js', 'C:\\project')
      const chip = container.querySelector('.markdown-inline-file') as HTMLElement
      expect(chip).not.toBeNull()
      expect(chip.querySelector('svg')).not.toBeNull()

      await act(async () => {
        chip.click()
      })
      expect(shown).toEqual([{ workspaceRoot: 'C:\\project', filePath: 'src/main.js', line: 12 }])
      // The viewer took it; the external opener is only a fallback.
      expect(openFileReference).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it('leaves a filename the project does not contain as plain text', async () => {
    const resolveFileReference = vi.fn(async () => ({ ok: false, matches: [] }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...window.api, workspace: { ...window.api?.workspace, resolveFileReference } }
    })
    await act(async () => {
      root.render(<MessageMarkdown content="See `ghost.ts`." workspaceRoot={'C:\\project'} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.querySelector('.markdown-inline-file')).toBeNull()
    expect(container.querySelector('code')?.textContent).toBe('ghost.ts')
  })
})

describe('MessageMarkdown code blocks', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // As in the app, where the window refuses the browser's clipboard permission.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(new Error('Write permission denied.'))) }
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const render = async (writeText: (text: string) => Promise<unknown>): Promise<HTMLElement> => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...window.api, clipboard: { writeText } }
    })
    await act(async () => {
      root.render(<MessageMarkdown content={'```bash\nnpm run dev\n```'} />)
    })
    return container.querySelector<HTMLElement>('[aria-label="Copy code"]')!
  }

  it('copies a code block through SideKick, not the refused browser clipboard', async () => {
    const writeText = vi.fn(async () => ({ success: true }))
    const copy = await render(writeText)
    await act(async () => copy.click())

    expect(writeText).toHaveBeenCalledWith('npm run dev')
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-label="Code copied"]')?.textContent).toContain('Copied')
  })

  it('does not claim a copy that failed', async () => {
    const copy = await render(vi.fn(async () => ({ success: false, error: 'Clipboard busy' })))
    await act(async () => copy.click())

    expect(container.querySelector('[aria-label="Code copied"]')).toBeNull()
  })
})
