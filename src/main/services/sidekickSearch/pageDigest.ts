import { estimateTextTokens } from '../../../shared/contextBudget'
import type { PageContent } from './types'

/** What a page read hands the model, within its budget. */
export interface PageDigest {
  /** The page as the model reads it. */
  text: string
  /** The whole page in the same form, for reading on from where `text` stops. */
  full: string
  /** `text` leaves out parts of `full`. */
  reduced: boolean
}

/** The whole page in reading order: what it is, its main content, then everything around it. */
export function pageText(page: PageContent): string {
  const head = [
    `# ${page.title || page.url}`,
    `URL: ${page.url}`,
    ...(page.siteName ? [`Site: ${page.siteName}`] : []),
    ...(page.byline ? [`Byline: ${page.byline}`] : []),
    ...(page.details ?? [])
  ].join('\n')
  return [
    head,
    `## Main content\n\n${page.content}`,
    ...(page.elsewhere ? [`## Elsewhere on the page\n\n${page.elsewhere}`] : [])
  ].join('\n\n')
}

const STOP_WORDS = new Set(
  (
    'a an and are as at be but by can do does for from has have how i if in into is it its of on ' +
    'or so that the their there this to was what when where which who why will with you your ' +
    'about any all also get need page find show tell me more information details specific'
  ).split(' ')
)

function terms(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._+-]*/gu) ?? []
  return [
    ...new Set(
      words
        .map((word) => word.replace(/[._+-]+$/, ''))
        .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
        // A plural asks for the same thing as its singular.
        .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
    )
  ]
}

const SECTION_TOKENS = 600

/**
 * Splits `text` into pieces within a section's size at the coarsest break that has them:
 * paragraphs, then lines, then characters. Data such as an API's JSON has no paragraphs, and
 * kept whole it was one part larger than any read, so only a "left out" marker reached the model.
 */
function pieces(text: string, breaks: string[] = ['\n\n', '\n']): string[] {
  if (estimateTextTokens(text) <= SECTION_TOKENS) return [text]
  const [separator, ...finer] = breaks
  if (separator === undefined) {
    const size = Math.max(1, Math.floor((text.length * SECTION_TOKENS) / estimateTextTokens(text)))
    return Array.from({ length: Math.ceil(text.length / size) }, (_, index) =>
      text.slice(index * size, (index + 1) * size)
    )
  }
  const output: string[] = []
  let piece = ''
  for (const unit of text.split(separator)) {
    const next = piece ? `${piece}${separator}${unit}` : unit
    if (estimateTextTokens(next) <= SECTION_TOKENS) {
      piece = next
    } else if (piece && estimateTextTokens(unit) <= SECTION_TOKENS) {
      output.push(piece)
      piece = unit
    } else {
      // Split finer together with what leads into it, so a heading keeps the start of its data.
      const split = pieces(next, finer)
      piece = split.pop() ?? ''
      output.push(...split)
    }
  }
  if (piece) output.push(piece)
  return output
}

/** Splits at headings, and a long stretch without one into pieces. */
function sections(text: string): string[] {
  const byHeading: string[] = []
  let fence: string | null = null
  let current: string[] = []
  for (const line of text.split('\n')) {
    const opener = line.match(/^(`{3,})/)?.[1]
    if (fence) {
      if (line.startsWith(fence)) fence = null
    } else if (opener) {
      fence = opener
    } else if (/^#{1,6} /.test(line) && current.some((entry) => entry.trim())) {
      byHeading.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.length) byHeading.push(current.join('\n'))

  return byHeading.flatMap((section) => pieces(section))
}

/**
 * The page within a token budget. A page that fits is returned whole. A larger one keeps its
 * opening, then the parts that best match what the caller said it needed, in page order, with a
 * marker wherever something was left out. Keeping only the start and end of a long page dropped
 * whatever was asked for in the middle.
 */
export function digestPage(
  page: PageContent,
  informationNeeded: string,
  maxTokens: number
): PageDigest {
  const full = pageText(page)
  if (estimateTextTokens(full) <= maxTokens) return { text: full, full, reduced: false }

  const parts = sections(full)
  const wanted = terms(informationNeeded)
  const score = (part: string): number => {
    const words = new Set(terms(part))
    const lower = part.toLowerCase()
    let total = 0
    for (const term of wanted) {
      if (words.has(term)) total += 3
      else if (lower.includes(term)) total += 1
    }
    return total
  }

  const cost = parts.map((part) => estimateTextTokens(part) + 2)
  const chosen = new Set<number>()
  let used = 0
  const take = (index: number): void => {
    if (chosen.has(index) || used + cost[index] > maxTokens) return
    chosen.add(index)
    used += cost[index]
  }
  // The page's identity and the start of its main content frame everything else.
  take(0)
  take(1)
  parts
    .map((part, index) => ({ index, score: score(part) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .forEach(({ index }) => take(index))
  // What is left of the budget goes to the rest of the page, in order.
  parts.forEach((_, index) => take(index))

  const output: string[] = []
  let skipped = 0
  parts.forEach((part, index) => {
    if (chosen.has(index)) {
      if (skipped)
        output.push(`[… ${skipped} part${skipped === 1 ? '' : 's'} of the page left out]`)
      skipped = 0
      output.push(part)
    } else {
      skipped += 1
    }
  })
  if (skipped) output.push(`[… ${skipped} part${skipped === 1 ? '' : 's'} of the page left out]`)
  return { text: output.join('\n\n'), full, reduced: true }
}
