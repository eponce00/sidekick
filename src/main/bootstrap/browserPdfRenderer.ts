import { app } from 'electron'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { pathToFileURL } from 'url'

// Match native browser screenshot allocation limits. Reject rather than resize:
// the viewer's page and annotation coordinates must retain their requested scale.
const MAX_PDF_RENDER_DIMENSION = 16_384
const MAX_PDF_RENDER_PIXELS = 40_000_000

let pdfRuntime: Promise<{
  pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs')
  canvas: typeof import('@napi-rs/canvas')
}> | null = null

async function runtime(): Promise<Awaited<NonNullable<typeof pdfRuntime>>> {
  if (!pdfRuntime) {
    pdfRuntime = (async () => {
      const roots = [app.getAppPath(), process.cwd()]
      const packageRoot = roots.find((root) =>
        existsSync(join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs'))
      )
      if (!packageRoot) throw new Error('PDF.js rendering runtime is missing')
      const moduleUrl = pathToFileURL(
        join(packageRoot, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')
      ).href
      const pdfjs = (await import(moduleUrl)) as typeof import('pdfjs-dist/legacy/build/pdf.mjs')
      const requireFromPackage = createRequire(join(packageRoot, 'package.json'))
      const canvas = requireFromPackage('@napi-rs/canvas') as typeof import('@napi-rs/canvas')
      const globals = globalThis as unknown as Record<string, unknown>
      globals.DOMMatrix ??= canvas.DOMMatrix
      globals.ImageData ??= canvas.ImageData
      globals.Path2D ??= canvas.Path2D
      return { pdfjs, canvas }
    })()
  }
  return pdfRuntime
}

/** Render one PDF page outside Chromium's hidden compositor. */
export async function renderBrowserPdfPage(
  sourceBytes: Uint8Array,
  pageNumber: number,
  scale: number
): Promise<Buffer> {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('PDF page render scale must be a finite positive number')
  }
  const { pdfjs, canvas } = await runtime()
  const task = pdfjs.getDocument({
    data: new Uint8Array(sourceBytes),
    useSystemFonts: true
  })
  try {
    const document = await task.promise
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
      throw new Error('PDF page number is out of range')
    }
    const page = await document.getPage(pageNumber)
    const viewport = page.getViewport({ scale })
    if (
      !Number.isFinite(viewport.width) ||
      !Number.isFinite(viewport.height) ||
      viewport.width <= 0 ||
      viewport.height <= 0
    ) {
      throw new Error(
        'PDF page render has invalid dimensions; page dimensions must be finite and positive'
      )
    }
    const width = Math.ceil(viewport.width)
    const height = Math.ceil(viewport.height)
    if (
      width > MAX_PDF_RENDER_DIMENSION ||
      height > MAX_PDF_RENDER_DIMENSION ||
      width * height > MAX_PDF_RENDER_PIXELS
    ) {
      throw new Error(
        'PDF page render exceeds the safety budget of 16,384 pixels per side and 40,000,000 total pixels. Use a lower rendering scale where available, or open the document in an external PDF viewer.'
      )
    }
    const target = canvas.createCanvas(width, height)
    const context = target.getContext('2d')
    await page.render({
      canvas: target as unknown as HTMLCanvasElement,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
      annotationMode: pdfjs.AnnotationMode.DISABLE
    }).promise
    return target.toBuffer('image/png')
  } finally {
    await task.destroy().catch(() => undefined)
  }
}
