/**
 * Defects an artifact's own document shows without anyone looking at it: content wider than the
 * chat column, sideways scrolling, text cut off or squeezed into a column of letters, chart labels
 * past their chart's edge, and values such as NaN. These were most of what reviewing a screenshot
 * found, and named this way a model can fix them in one step, with or without seeing images.
 */

const MAX_PROBLEMS = 6
const SAMPLE = 3

function describe(element: Element): string {
  const tag = element.tagName.toLowerCase()
  const classes =
    typeof element.className === 'string'
      ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 4).join(' ')
      : ''
  const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ')
  const quoted = text ? ` “${text.length > 40 ? `${text.slice(0, 39)}…` : text}”` : ''
  return `<${tag}${classes ? ` class="${classes}"` : ''}>${quoted}`
}

/** The outermost of the matching elements, so one cause is named once. */
function outermost(elements: Element[]): Element[] {
  return elements.filter(
    (element) => !elements.some((other) => other !== element && other.contains(element))
  )
}

export function findArtifactLayoutProblems(doc: Document | null | undefined): string[] {
  const view = doc?.defaultView
  if (!doc?.body || !view) return []
  const problems: string[] = []
  const columnWidth = doc.documentElement.clientWidth
  const elements = [...doc.body.querySelectorAll('*')]

  const pageWidth = doc.documentElement.scrollWidth
  if (pageWidth > columnWidth + 1) {
    const past = outermost(
      elements.filter((element) => {
        const box = element.getBoundingClientRect()
        return box.width > 0 && box.right > columnWidth + 1
      })
    ).slice(0, SAMPLE)
    problems.push(
      `It is ${pageWidth}px wide but the chat column is ${columnWidth}px, so its right side is cut off${
        past.length ? `: ${past.map(describe).join(', ')}` : ''
      }. Let rows wrap or shrink (flex-wrap, grid with minmax(0, 1fr), max-width: 100%) instead of fixed widths.`
    )
  }

  const scrolling: Element[] = []
  const clipped: Element[] = []
  const squeezed: Element[] = []
  for (const element of elements) {
    const style = view.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const overflowsSideways = element.scrollWidth > element.clientWidth + 1
    if (overflowsSideways && /auto|scroll/.test(style.overflowX)) scrolling.push(element)
    const ownText = [...element.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
    )
    if (!ownText) continue
    if (overflowsSideways && style.overflowX === 'hidden' && style.textOverflow !== 'ellipsis') {
      clipped.push(element)
    }
    const box = element.getBoundingClientRect()
    const fontSize = parseFloat(style.fontSize) || 14
    const text = element.textContent?.trim() ?? ''
    if (
      text.length >= 4 &&
      box.width > 0 &&
      box.width < fontSize * 2.2 &&
      box.height > fontSize * 3.5
    ) {
      squeezed.push(element)
    }
  }
  if (scrolling.length) {
    problems.push(
      `Part of it scrolls sideways inside the chat: ${outermost(scrolling).slice(0, SAMPLE).map(describe).join(', ')}. Make it fit the column: wrap, use fewer or narrower items, or a grid with repeat(auto-fit, minmax(…, 1fr)).`
    )
  }
  if (clipped.length) {
    problems.push(
      `Text is cut off by its box: ${outermost(clipped).slice(0, SAMPLE).map(describe).join(', ')}. Give it room or let it wrap.`
    )
  }
  if (squeezed.length) {
    problems.push(
      `Text is squeezed into a column of single letters: ${squeezed.slice(0, SAMPLE).map(describe).join(', ')}. It has almost no width, as with left: 100% or a zero-width flex item; anchor it with right: 0 or give it white-space: nowrap.`
    )
  }

  const cutLabels: Element[] = []
  for (const label of doc.querySelectorAll('svg text')) {
    const svg = label.closest('svg')
    if (!svg || view.getComputedStyle(svg).overflow === 'visible') continue
    const text = label.getBoundingClientRect()
    const bounds = svg.getBoundingClientRect()
    if (!text.width) continue
    if (
      text.left < bounds.left - 1 ||
      text.right > bounds.right + 1 ||
      text.top < bounds.top - 1 ||
      text.bottom > bounds.bottom + 1
    ) {
      cutLabels.push(label)
    }
  }
  if (cutLabels.length) {
    problems.push(
      `Chart labels run past the chart's edge and are cut off: ${cutLabels.slice(0, SAMPLE).map(describe).join(', ')}. Leave room for them: no negative chart margins; give the axis a width, such as <YAxis width={44} />, or add margin on that side.`
    )
  }

  const visibleText = doc.body.innerText
  const bad = ['NaN', 'undefined', '[object Object]', 'Infinity'].filter((token) =>
    new RegExp(`(^|[^\\w])${token.replace(/[[\]]/g, '\\$&')}([^\\w]|$)`).test(visibleText)
  )
  if (bad.length) {
    problems.push(
      `It shows ${bad.map((token) => `“${token}”`).join(', ')} where a value should be: a calculation or a field it reads is missing.`
    )
  }

  return problems.slice(0, MAX_PROBLEMS)
}
