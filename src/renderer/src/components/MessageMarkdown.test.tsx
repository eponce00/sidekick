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
    container.remove()
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
    expect(link.target).toBe('_blank')
    expect(link.rel).toContain('noreferrer')
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

  it('keeps fenced code together while splitting stable streamed blocks', () => {
    expect(
      splitMarkdownRenderBlocks(
        'First paragraph.\n\n```ts\nconst x = 1\n\nconst y = 2\n```\n\nTail'
      )
    ).toEqual(['First paragraph.\n\n', '```ts\nconst x = 1\n\nconst y = 2\n```\n\n', 'Tail'])
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
    expect(container.querySelector('[aria-label="Code copied"]')).not.toBeNull()
  })

  it('does not claim a copy that failed', async () => {
    const copy = await render(vi.fn(async () => ({ success: false, error: 'Clipboard busy' })))
    await act(async () => copy.click())

    expect(container.querySelector('[aria-label="Code copied"]')).toBeNull()
  })
})
