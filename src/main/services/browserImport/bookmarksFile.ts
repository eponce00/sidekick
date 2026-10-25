import { BROWSER_IMPORT_LIMITS } from '../../../shared/browserLibrary'
import { BookmarkCollector, type ImportedBookmark } from './importedData'

/**
 * Reads the bookmarks file every browser exports (the Netscape bookmark format): folders are `<H3>`
 * headings each followed by a `<DL>` list, and bookmarks are `<A HREF>` links. The scan finds each
 * tag's end with `indexOf`, so its time stays linear in the file's size whatever the file holds.
 * https://learn.microsoft.com/previous-versions/windows/internet-explorer/ie-developer/platform-apis/aa753582(v=vs.85)
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : ''
    }
    const lower = name.toLowerCase()
    return Object.hasOwn(ENTITIES, lower) ? ENTITIES[lower] : whole
  })
}

/** Longest stretch read for one title: titles are cut far shorter, and this bounds the work. */
const MAX_TEXT = 4_096

/** Text with any tags inside it removed. */
function innerText(html: string): string {
  return decodeEntities(html.slice(0, MAX_TEXT).replace(/<[^<>]*>/g, ''))
}

/** A tag's attributes by lowercase name, read in one pass; the first of a repeated name wins. */
function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>()
  const space = /[\s/]/
  let index = tag.search(/[\s/>]/)
  while (index >= 0 && index < tag.length) {
    while (index < tag.length && space.test(tag[index])) index++
    const nameStart = index
    while (index < tag.length && !/[\s=>/]/.test(tag[index])) index++
    const name = tag.slice(nameStart, index).toLowerCase()
    if (!name) break
    while (index < tag.length && space.test(tag[index])) index++
    let value = ''
    if (tag[index] === '=') {
      index++
      while (index < tag.length && space.test(tag[index])) index++
      const quote = tag[index]
      if (quote === '"' || quote === "'") {
        const close = tag.indexOf(quote, index + 1)
        value = tag.slice(index + 1, close < 0 ? tag.length : close)
        index = close < 0 ? tag.length : close + 1
      } else {
        const valueStart = index
        while (index < tag.length && !/[\s>]/.test(tag[index])) index++
        value = tag.slice(valueStart, index)
      }
    }
    if (!found.has(name)) found.set(name, decodeEntities(value))
  }
  return found
}

export function parseBookmarksFile(html: string): ImportedBookmark[] {
  const lower = html.toLowerCase()
  if (!lower.includes('<dl') || !lower.includes('<a')) throw new Error('Not a bookmarks file')
  const collector = new BookmarkCollector()
  // Open lists; each holds the folder it belongs to, or null for a list with no heading.
  const lists: Array<string | null> = []
  let heading: string | null = null
  let position = 0
  // Once a closing tag is missing from the rest of the file, it is not searched for again.
  const unclosed = new Set<string>()
  while (!collector.full) {
    const start = lower.indexOf('<', position)
    if (start < 0) break
    const end = lower.indexOf('>', start)
    if (end < 0) break
    const tag = html.slice(start, end + 1)
    const name = /^<\s*(\/?)([a-z0-9]+)/.exec(lower.slice(start, Math.min(end + 1, start + 16)))
    position = end + 1
    if (!name) continue
    const [, closing, element] = name
    if (element === 'dl') {
      if (closing) lists.pop()
      else if (lists.length < BROWSER_IMPORT_LIMITS.folderDepth + 1) {
        lists.push(heading)
        heading = null
      } else {
        // Too deep: nested lists still count, so closing tags stay paired, but add no folder.
        lists.push(null)
      }
    } else if (!closing && (element === 'h3' || element === 'a')) {
      const close = unclosed.has(element) ? -1 : lower.indexOf(`</${element}`, position)
      if (close < 0) unclosed.add(element)
      const text = innerText(html.slice(position, close < 0 ? position : close))
      const attrs = attributes(tag)
      if (close >= 0) position = close
      if (element === 'h3') {
        heading =
          attrs.get('personal_toolbar_folder')?.toLowerCase() === 'true'
            ? 'Bookmarks bar'
            : text.trim() || 'Folder'
      } else {
        const folder = lists.filter((entry): entry is string => entry !== null)
        collector.add(folder.length ? folder : ['Bookmarks'], text, attrs.get('href'))
      }
    }
  }
  return collector.bookmarks
}
