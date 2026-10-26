import type { BrowserAnnotationCdp } from './browserAnnotationCapture'

/**
 * Find in page for the Browser panel. Electron's own find reports nothing for a page in a
 * WebContentsView, so the search runs through the page's debugger in a world of SideKick's own:
 * page scripts share only the document with it. Matches are marked with the browser's highlight
 * registry, the selected one brighter, and it is scrolled into view.
 */
const FIND_WORLD = 'sidekick-find'
const MAX_MATCHES = 1000

/** In the isolated world: finds `text` again, or moves `step` matches from the selected one. */
const FIND_SCRIPT = `(text, step, limit) => {
  const state = (globalThis.__sidekickFind ??= { text: '', index: 0 })
  const registry = globalThis.CSS && CSS.highlights
  const styleId = 'sidekick-find-style'
  if (!text) {
    registry?.delete('sidekick-find')
    registry?.delete('sidekick-find-active')
    document.getElementById(styleId)?.remove()
    state.text = ''
    return { active: 0, matches: 0 }
  }
  const needle = text.toLocaleLowerCase()
  const ranges = []
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      if (!parent || parent.closest('script, style, noscript, template')) return NodeFilter.FILTER_REJECT
      return parent.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    }
  })
  for (let node = walker.nextNode(); node && ranges.length < limit; node = walker.nextNode()) {
    const value = node.nodeValue.toLocaleLowerCase()
    for (let at = value.indexOf(needle); at >= 0 && ranges.length < limit; at = value.indexOf(needle, at + needle.length)) {
      const range = new Range()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      ranges.push(range)
    }
  }
  state.index = state.text === text && ranges.length
    ? (state.index + step + ranges.length) % ranges.length
    : 0
  state.text = text
  if (registry && typeof Highlight === 'function') {
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style')
      style.id = styleId
      style.textContent = '::highlight(sidekick-find){background:#fde68a;color:#111}::highlight(sidekick-find-active){background:#f59e0b;color:#111}'
      ;(document.head ?? document.documentElement).append(style)
    }
    registry.set('sidekick-find', new Highlight(...ranges))
    if (ranges.length) registry.set('sidekick-find-active', new Highlight(ranges[state.index]))
    else registry.delete('sidekick-find-active')
  }
  ranges[state.index]?.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' })
  return { active: ranges.length ? state.index + 1 : 0, matches: ranges.length }
}`

// The isolated world of each page, by its WebContents, until a navigation takes it away.
const worlds = new Map<number, number>()

async function findWorld(webContentsId: number, send: BrowserAnnotationCdp): Promise<number> {
  const known = worlds.get(webContentsId)
  if (known !== undefined) return known
  const tree = await send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree')
  const world = await send<{ executionContextId: number }>('Page.createIsolatedWorld', {
    frameId: tree.frameTree.frame.id,
    worldName: FIND_WORLD,
    grantUniveralAccess: false
  })
  worlds.set(webContentsId, world.executionContextId)
  return world.executionContextId
}

/**
 * Finds text on a page and says which match is selected of how many; `next` moves to the next
 * match, or the previous one unless `forward`. No text ends the search and clears its marks.
 */
export async function findInBrowserPage(
  page: { webContentsId: number; send: BrowserAnnotationCdp },
  find: { text: string; forward?: boolean; next?: boolean } | undefined
): Promise<{ active: number; matches: number } | undefined> {
  const text = find?.text ?? ''
  const step = find?.next ? (find.forward === false ? -1 : 1) : 0
  const expression = `(${FIND_SCRIPT})(${JSON.stringify(text)}, ${step}, ${MAX_MATCHES})`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const contextId = await findWorld(page.webContentsId, page.send)
    const result = await page
      .send<{
        result?: { value?: { active: number; matches: number } }
        exceptionDetails?: unknown
      }>('Runtime.evaluate', { expression, contextId, returnByValue: true })
      .catch(() => undefined)
    const value = result?.result?.value
    if (value && Number.isInteger(value.active) && Number.isInteger(value.matches))
      return text ? { active: value.active, matches: value.matches } : undefined
    // The page navigated, and its world with it: a new one is made once.
    worlds.delete(page.webContentsId)
  }
  return undefined
}
