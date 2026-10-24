import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * A reply as it reads, for the clipboard: HTML keeps headings, lists, bold and tables where the
 * paste target formats text (notes, mail, documents), and the plain text drops the Markdown marks
 * for places that take text only. No raw HTML from the reply is rendered.
 */
export function formattedCopy(markdown: string): { html: string; text: string } {
  const html = renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
      {markdown}
    </ReactMarkdown>
  )
  return { html, text: plainTextOf(html) }
}

/** The text an HTML fragment shows, one block per line, as reading it aloud would give. */
export function plainTextOf(html: string): string {
  const body = new DOMParser().parseFromString(html, 'text/html').body
  const lines: string[] = []
  let line = ''
  const flush = (): void => {
    if (line.trim()) lines.push(line.replace(/ +/g, ' ').trim())
    line = ''
  }
  const walk = (node: Node, listDepth: number): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      line += node.textContent ?? ''
      return
    }
    if (!(node instanceof HTMLElement)) return
    const tag = node.tagName
    if (tag === 'BR') return flush()
    if (tag === 'LI') {
      flush()
      const ordered = node.parentElement?.tagName === 'OL'
      const index = [...(node.parentElement?.children ?? [])].indexOf(node) + 1
      line += `${'  '.repeat(Math.max(0, listDepth - 1))}${ordered ? `${index}.` : '•'} `
    }
    const block = /^(P|DIV|H[1-6]|LI|PRE|BLOCKQUOTE|TR|TABLE|UL|OL|HR)$/.test(tag)
    if (block && tag !== 'LI') flush()
    for (const child of node.childNodes)
      walk(child, tag === 'UL' || tag === 'OL' ? listDepth + 1 : listDepth)
    if (tag === 'TD' || tag === 'TH') line += '\t'
    if (block) flush()
  }
  for (const child of body.childNodes) walk(child, 0)
  flush()
  return lines.join('\n')
}

/**
 * Puts both forms on the clipboard. A secure page writes them directly; a plain HTTP page, where
 * browsers withhold that API, sets them in the copy a button press starts.
 */
export async function copyFormatted(markdown: string): Promise<boolean> {
  const { html, text } = formattedCopy(markdown)
  try {
    if (
      window.isSecureContext &&
      navigator.clipboard?.write &&
      typeof ClipboardItem !== 'undefined'
    ) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' })
        })
      ])
      return true
    }
  } catch {
    /* Falls back to the copy event. */
  }
  let written = false
  const onCopy = (event: ClipboardEvent): void => {
    event.clipboardData?.setData('text/html', html)
    event.clipboardData?.setData('text/plain', text)
    written = Boolean(event.clipboardData)
    event.preventDefault()
  }
  document.addEventListener('copy', onCopy)
  try {
    return document.execCommand('copy') && written
  } catch {
    return false
  } finally {
    document.removeEventListener('copy', onCopy)
  }
}
