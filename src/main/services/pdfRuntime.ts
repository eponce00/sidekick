import { app } from 'electron'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { pathToFileURL } from 'url'

export interface PdfRuntime {
  pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs')
  canvas: typeof import('@napi-rs/canvas')
  /** PDF.js's own data: fonts a PDF names without embedding, CMaps for CJK text, and decoders. */
  dataOptions: {
    cMapUrl: string
    cMapPacked: true
    standardFontDataUrl: string
    wasmUrl: string
    iccUrl: string
  }
}

let pdfRuntime: Promise<PdfRuntime> | null = null

/** PDF.js and the canvas it draws on, loaded once for the main process. */
export async function loadPdfRuntime(): Promise<PdfRuntime> {
  if (!pdfRuntime) {
    pdfRuntime = (async () => {
      const roots = [app.getAppPath(), process.cwd()]
      const packageRoot = roots.find((root) =>
        existsSync(join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs'))
      )
      if (!packageRoot) throw new Error('PDF.js rendering runtime is missing')
      const pdfjsRoot = join(packageRoot, 'node_modules', 'pdfjs-dist')
      const moduleUrl = pathToFileURL(join(pdfjsRoot, 'legacy', 'build', 'pdf.mjs')).href
      const pdfjs = (await import(moduleUrl)) as typeof import('pdfjs-dist/legacy/build/pdf.mjs')
      const requireFromPackage = createRequire(join(packageRoot, 'package.json'))
      const canvas = requireFromPackage('@napi-rs/canvas') as typeof import('@napi-rs/canvas')
      const globals = globalThis as unknown as Record<string, unknown>
      globals.DOMMatrix ??= canvas.DOMMatrix
      globals.ImageData ??= canvas.ImageData
      globals.Path2D ??= canvas.Path2D
      // PDF.js wants a trailing forward slash, on Windows too.
      const folder = (name: string): string => join(pdfjsRoot, name) + '/'
      return {
        pdfjs,
        canvas,
        dataOptions: {
          cMapUrl: folder('cmaps'),
          cMapPacked: true,
          standardFontDataUrl: folder('standard_fonts'),
          wasmUrl: folder('wasm'),
          iccUrl: folder('iccs')
        }
      }
    })()
  }
  return pdfRuntime
}
