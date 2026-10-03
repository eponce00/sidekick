/**
 * Converts page HTML to Markdown, so a model reading a page keeps what plain text loses: headings
 * that say where a fact sits, link targets, code blocks, lists and table rows.
 */

const SKIPPED = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'SVG',
  'CANVAS',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'HEAD',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'OPTION'
])

const BLOCKS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BODY',
  'DD',
  'DETAILS',
  'DIALOG',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'HEADER',
  'HGROUP',
  'MAIN',
  'NAV',
  'P',
  'SECTION',
  'SUMMARY'
])

function isHidden(element: Element): boolean {
  if (element.hasAttribute('hidden')) return true
  const style = element.getAttribute('style')?.replace(/\s+/g, '').toLowerCase() ?? ''
  return style.includes('display:none') || style.includes('visibility:hidden')
}

function absoluteUrl(value: string | null, baseUrl: string): string | undefined {
  if (!value || value.startsWith('#') || value.startsWith('javascript:')) return undefined
  try {
    const url = new URL(value, baseUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function inline(text: string): string {
  return text.replace(/\s+/g, ' ')
}

function codeFence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length))
  return '`'.repeat(longest + 1)
}

function tableMarkdown(table: Element, render: (node: Node) => string): string {
  const rows = [...table.querySelectorAll('tr')].filter((row) => row.closest('table') === table)
  const cells = rows
    .map((row) =>
      [...row.children]
        .filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
        .map((cell) => inline(render(cell)).trim().replace(/\|/g, '\\|'))
    )
    .filter((row) => row.some((cell) => cell))
  if (!cells.length) return ''
  const width = Math.max(...cells.map((row) => row.length))
  const line = (row: string[]): string =>
    `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`
  return [
    line(cells[0]),
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...cells.slice(1).map(line)
  ].join('\n')
}

export function htmlToMarkdown(root: Node, baseUrl: string): string {
  const render = (node: Node): string => {
    if (node.nodeType === 3) return inline(node.textContent ?? '')
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return ''
    const element = node as Element
    const tag = element.tagName ?? ''
    if (SKIPPED.has(tag) || (element.tagName && isHidden(element))) return ''
    const children = (): string => [...node.childNodes].map((child) => render(child)).join('')

    switch (tag) {
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6': {
        const text = inline(children()).trim()
        return text ? `\n\n${'#'.repeat(Number(tag[1]))} ${text}\n\n` : ''
      }
      case 'BR':
        return '\n'
      case 'HR':
        return '\n\n---\n\n'
      case 'A': {
        const text = inline(children()).trim()
        const href = absoluteUrl(element.getAttribute('href'), baseUrl)
        if (!text) return ''
        return href && href !== text ? `[${text}](${href})` : text
      }
      case 'IMG': {
        const alt = inline(element.getAttribute('alt') ?? '').trim()
        const src = absoluteUrl(element.getAttribute('src'), baseUrl)
        return alt && src ? `![${alt}](${src})` : alt
      }
      case 'STRONG':
      case 'B': {
        const text = children()
        return text.trim() ? `**${text.trim()}**` : text
      }
      case 'EM':
      case 'I': {
        const text = children()
        return text.trim() ? `_${text.trim()}_` : text
      }
      case 'CODE': {
        const text = element.textContent ?? ''
        if (!text.trim()) return ''
        const fence = text.includes('`') ? '``' : '`'
        return `${fence}${inline(text)}${fence}`
      }
      case 'PRE': {
        const text = (element.textContent ?? '').replace(/\n+$/, '')
        if (!text.trim()) return ''
        const language =
          (element.querySelector('code')?.className ?? element.className).match(
            /(?:^|\s)(?:language|lang|highlight-source)-([\w+#-]+)/
          )?.[1] ?? ''
        const fence = codeFence(text)
        return `\n\n${fence}${language}\n${text}\n${fence}\n\n`
      }
      case 'BLOCKQUOTE': {
        const text = children().trim()
        return text
          ? `\n\n${text
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n')}\n\n`
          : ''
      }
      case 'UL':
      case 'OL': {
        const items = [...element.children].filter((child) => child.tagName === 'LI')
        const lines = items
          .map((item, index) => {
            const marker = tag === 'OL' ? `${index + 1}.` : '-'
            const body = render(item)
              .trim()
              .replace(/\n{2,}/g, '\n')
            if (!body) return ''
            // A nested list is part of the item's body, so this indent is the nesting.
            return `${marker} ${body.replace(/\n/g, '\n  ')}`
          })
          .filter(Boolean)
        return lines.length ? `\n\n${lines.join('\n')}\n\n` : ''
      }
      case 'LI':
        return children()
      case 'TABLE': {
        const table = tableMarkdown(element, (cell) => render(cell))
        return table ? `\n\n${table}\n\n` : ''
      }
      case 'TR':
      case 'TD':
      case 'TH':
        return `${children()} `
      default:
        return BLOCKS.has(tag) ? `\n\n${children()}\n\n` : children()
    }
  }

  return tidy(render(root))
}

/** Drops the stray spaces the HTML's own indentation leaves at line starts, except in code. */
function tidy(markdown: string): string {
  let fence: string | null = null
  const lines = markdown.split('\n').map((line) => {
    const opener = line.match(/^(`{3,})/)?.[1]
    if (fence) {
      if (line.startsWith(fence)) fence = null
      return line
    }
    if (opener) {
      fence = opener
      return line
    }
    const trimmed = line.trimEnd()
    // List nesting is meaningful indentation; anything else is markup whitespace.
    return /^\s*(?:[-*]|\d+\.)\s/.test(trimmed) ? trimmed : trimmed.trimStart()
  })
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
