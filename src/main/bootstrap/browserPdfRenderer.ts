import { app } from 'electron'
import { existsSync, promises as fs } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { pathToFileURL } from 'url'

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
  sourcePath: string,
  pageNumber: number,
  scale: number
): Promise<Buffer> {
  const { pdfjs, canvas } = await runtime()
  const bytes = await fs.readFile(sourcePath)
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true
  })
  try {
    const document = await task.promise
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
      throw new Error('PDF page number is out of range')
    }
    const page = await document.getPage(pageNumber)
    const viewport = page.getViewport({ scale })
    const target = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
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
