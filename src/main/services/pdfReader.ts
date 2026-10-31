import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { estimateTextTokens } from '../../shared/contextBudget'
import { MAX_TOOL_RESULT_MEDIA, type ToolResultMediaAttachment } from '../../shared/agentRuntime'
import { loadPdfRuntime, type PdfRuntime } from './pdfRuntime'
import { recognizeTextInImages, type SystemOcrResult } from './systemOcr'

/** As many pages as Claude Code reads at once; a longer document is read in parts. */
export const MAX_PDF_PAGES_PER_READ = 20
/** OCR takes about a second a page, so a read recognizes this many and names the rest. */
const MAX_OCR_PAGES_PER_READ = 8
// Under the long side every provider profile accepts, so the copy sent is not resized again.
const PAGE_IMAGE_LONG_EDGE = 1568
// OCR reads small print better from a larger page.
const OCR_IMAGE_LONG_EDGE = 2400
// Fewer letters than a short heading: the page is a picture of text, or empty.
const SCANNED_PAGE_CHARACTERS = 10
const PICTURE_COVERAGE = 0.08
// A chart or diagram drawn with lines and shapes; a few rules and boxes are only decoration.
const DRAWING_PATHS = 60

export class PdfReadError extends Error {
  constructor(
    readonly code: 'password' | 'invalid' | 'pages',
    message: string
  ) {
    super(message)
    this.name = 'PdfReadError'
  }
}

export interface PdfReadOptions {
  /** Pages such as "3", "2-5" or "1,4-6"; the start of the document by default. */
  pages?: string
  maxTokens: number
  /** Page images the model may receive in this result; 0 when it reads text only. */
  imageBudget: number
  label: string
  signal?: AbortSignal
  recognize?: (imagePaths: readonly string[], signal?: AbortSignal) => Promise<SystemOcrResult>
}

export interface PdfReadResult {
  totalPages: number
  pagesRead: number[]
  nextPage: number | null
  content: string
  media: ToolResultMediaAttachment[]
  /** The pages in `media`, in the same order, for the chat to show what the model was shown. */
  shownPages: Array<{ page: number; image: Buffer }>
}

type PageLook = 'text' | 'scan' | 'blank' | 'pictures'

interface PageReading {
  number: number
  text: string
  look: PageLook
  image?: boolean
  ocr?: 'recognized' | 'unavailable' | 'failed' | 'deferred'
}

type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function multiply(m: Matrix, n: readonly number[]): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ]
}

export function parsePdfPages(spec: string | undefined, totalPages: number): number[] {
  if (!spec?.trim()) return Array.from({ length: totalPages }, (_, index) => index + 1)
  const pages = new Set<number>()
  for (const part of spec.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d*)\s*)?$/.exec(part)
    if (!match) throw new PdfReadError('pages', `"${part.trim()}" is not a page or a range.`)
    const first = Number(match[1])
    const last = match[2] === undefined ? first : match[2] === '' ? totalPages : Number(match[2])
    if (first < 1 || last < first || first > totalPages)
      throw new PdfReadError('pages', `Pages ${part.trim()} are outside 1-${totalPages}.`)
    for (let page = first; page <= Math.min(last, totalPages); page++) pages.add(page)
  }
  return [...pages].sort((a, b) => a - b)
}

/** Pages as short ranges: page 4, pages 1-8, or pages 2, 5-7. */
export function pdfPagesLabel(pages: readonly number[]): string {
  const ranges: string[] = []
  for (let index = 0; index < pages.length; index++) {
    const first = pages[index]
    while (pages[index + 1] === pages[index] + 1) index++
    ranges.push(first === pages[index] ? `${first}` : `${first}-${pages[index]}`)
  }
  return pages.length === 1 ? `page ${pages[0]}` : `pages ${ranges.join(', ')}`
}

/** Whether the page carries its words as text, as a picture of text, or beside pictures. */
async function readPage(
  runtime: PdfRuntime,
  page: import('pdfjs-dist').PDFPageProxy
): Promise<{ text: string; look: PageLook }> {
  const content = await page.getTextContent()
  let text = ''
  for (const item of content.items) {
    if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '')
  }
  text = text.replace(/[ \t]+\n/g, '\n').trim()
  const { OPS } = runtime.pdfjs
  const imageOps = new Set<number>([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject,
    OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObjectRepeat
  ])
  const operators = await page.getOperatorList()
  // An image fills the unit square of the current transform, so its share of the page is the
  // transform's area; forms carry their own matrix.
  let matrix = IDENTITY
  const saved: Matrix[] = []
  let imageArea = 0
  let paths = 0
  for (let index = 0; index < operators.fnArray.length; index++) {
    const op = operators.fnArray[index]
    const args = operators.argsArray[index] as unknown[] | null
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      saved.push(matrix)
      if (op === OPS.paintFormXObjectBegin && Array.isArray(args?.[0]))
        matrix = multiply(matrix, args[0] as number[])
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      matrix = saved.pop() ?? IDENTITY
    } else if (op === OPS.transform && args) {
      matrix = multiply(matrix, args as number[])
    } else if (imageOps.has(op)) {
      imageArea += Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2])
    } else if (op === OPS.constructPath) {
      paths++
    }
  }
  const [x1, y1, x2, y2] = page.view
  const coverage = imageArea / Math.max(1, Math.abs((x2 - x1) * (y2 - y1)))
  const characters = text.replace(/\s/g, '').length
  const visual = coverage >= PICTURE_COVERAGE || paths >= DRAWING_PATHS
  const look: PageLook =
    characters < SCANNED_PAGE_CHARACTERS
      ? coverage >= 0.3 || paths >= DRAWING_PATHS
        ? 'scan'
        : visual
          ? 'pictures'
          : 'blank'
      : visual
        ? 'pictures'
        : 'text'
  return { text, look }
}

async function renderPage(
  runtime: PdfRuntime,
  page: import('pdfjs-dist').PDFPageProxy,
  longEdge: number,
  format: 'jpeg' | 'png'
): Promise<Buffer> {
  const [x1, y1, x2, y2] = page.view
  const scale = longEdge / Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1)
  const viewport = page.getViewport({ scale })
  const target = runtime.canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const context = target.getContext('2d')
  // Transparent pages render as black in JPEG.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, target.width, target.height)
  await page.render({
    canvas: target as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
    annotationMode: runtime.pdfjs.AnnotationMode.ENABLE_FORMS
  }).promise
  return format === 'jpeg' ? target.encode('jpeg', 85) : target.encode('png')
}

function pageHeading(reading: PageReading, totalPages: number, imageBudget: number): string {
  const notes: string[] = []
  if (reading.look === 'scan') notes.push('scanned: no text layer')
  if (reading.look === 'pictures') notes.push('has pictures or drawings')
  if (reading.look === 'blank') notes.push('blank')
  if (reading.ocr === 'recognized') notes.push('text recognized by OCR')
  else if (reading.ocr === 'unavailable') notes.push('OCR is unavailable on this computer')
  else if (reading.ocr === 'failed') notes.push('OCR failed')
  else if (reading.ocr === 'deferred') notes.push(`read pages "${reading.number}" to recognize it`)
  if (reading.image) notes.push('page image attached')
  else if (reading.look === 'pictures')
    notes.push(imageBudget ? `read pages "${reading.number}" to see it` : 'not shown to this model')
  return `--- Page ${reading.number} of ${totalPages}${notes.length ? ` (${notes.join('; ')})` : ''} ---`
}

/**
 * Read a PDF the way the model providers' own PDF support does: each page's text, and an image of
 * the pages whose text alone misses something. A scanned page's text comes from the computer's own
 * OCR, shown or not: an image leaves the conversation once newer ones fill the provider's budget,
 * and the words must outlast it.
 */
export async function readPdf(bytes: Uint8Array, options: PdfReadOptions): Promise<PdfReadResult> {
  const runtime = await loadPdfRuntime()
  const task = runtime.pdfjs.getDocument({
    data: new Uint8Array(bytes),
    // Node has no system fonts to offer PDF.js; a font the PDF names without embedding is drawn
    // with PDF.js's own copy of it.
    useSystemFonts: false,
    ...runtime.dataOptions
  })
  const scratch = join(tmpdir(), `sidekick-pdf-${randomUUID()}`)
  try {
    let document: import('pdfjs-dist').PDFDocumentProxy
    try {
      document = await task.promise
    } catch (error) {
      if ((error as { name?: string }).name === 'PasswordException')
        throw new PdfReadError('password', 'This PDF is password protected.')
      throw new PdfReadError('invalid', 'This file could not be opened as a PDF.')
    }
    const totalPages = document.numPages
    const requested = parsePdfPages(options.pages, totalPages)
    const readings: PageReading[] = []
    const pages = new Map<number, import('pdfjs-dist').PDFPageProxy>()
    let tokens = 0
    for (const number of requested.slice(0, MAX_PDF_PAGES_PER_READ)) {
      if (options.signal?.aborted) throw new DOMException('PDF read cancelled', 'AbortError')
      const page = await document.getPage(number)
      const { text, look } = await readPage(runtime, page)
      const pageTokens = estimateTextTokens(text) + 16
      // The first page is always returned, so a read past a very long page still moves on.
      if (readings.length && tokens + pageTokens > options.maxTokens) break
      tokens += pageTokens
      pages.set(number, page)
      readings.push({ number, text, look })
    }

    // Scans first, since their text is missing altogether; then pages with pictures. A read of
    // a few named pages shows each of them.
    const imageSlots = Math.min(options.imageBudget, MAX_TOOL_RESULT_MEDIA)
    const named = Boolean(options.pages?.trim()) && readings.length <= imageSlots
    const shown = named
      ? readings
      : [
          ...readings.filter((reading) => reading.look === 'scan'),
          ...readings.filter((reading) => reading.look === 'pictures')
        ].slice(0, imageSlots)
    const media: ToolResultMediaAttachment[] = []
    const shownPages: PdfReadResult['shownPages'] = []
    for (const reading of shown) {
      const image = await renderPage(
        runtime,
        pages.get(reading.number)!,
        PAGE_IMAGE_LONG_EDGE,
        'jpeg'
      )
      reading.image = true
      shownPages.push({ page: reading.number, image })
      media.push({
        type: 'image',
        mimeType: 'image/jpeg',
        name: `${options.label} page ${reading.number}`,
        description: `Page ${reading.number} of ${options.label}`,
        source: { type: 'data_url', dataUrl: `data:image/jpeg;base64,${image.toString('base64')}` }
      })
    }

    const scans = readings.filter((reading) => reading.look === 'scan')
    if (scans.length) {
      const recognize = options.recognize ?? recognizeTextInImages
      const now = scans.slice(0, MAX_OCR_PAGES_PER_READ)
      for (const reading of scans.slice(MAX_OCR_PAGES_PER_READ)) reading.ocr = 'deferred'
      await fs.mkdir(scratch, { recursive: true })
      const paths: string[] = []
      for (const reading of now) {
        const path = join(scratch, `page-${reading.number}.png`)
        await fs.writeFile(
          path,
          await renderPage(runtime, pages.get(reading.number)!, OCR_IMAGE_LONG_EDGE, 'png')
        )
        paths.push(path)
      }
      const result = await recognize(paths, options.signal)
      if (result.ok === false && result.reason === 'cancelled')
        throw new DOMException('PDF read cancelled', 'AbortError')
      now.forEach((reading, index) => {
        if (!result.ok) {
          reading.ocr = result.reason === 'unavailable' ? 'unavailable' : 'failed'
          return
        }
        reading.ocr = 'recognized'
        reading.text = result.texts[index]?.trim() || '(no text was recognized)'
      })
    }

    const pagesRead = readings.map((reading) => reading.number)
    const remaining = requested.filter((page) => !pagesRead.includes(page))
    const nextPage = remaining[0] ?? null
    const body = readings
      .map((reading) =>
        [pageHeading(reading, totalPages, options.imageBudget), reading.text]
          .filter(Boolean)
          .join('\n')
      )
      .join('\n\n')
    const continuation = nextPage
      ? `\n\n[Read again with pages "${nextPage}-${remaining.at(-1)}" to continue.]`
      : ''
    return { totalPages, pagesRead, nextPage, content: body + continuation, media, shownPages }
  } finally {
    await task.destroy().catch(() => undefined)
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}
