// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { BROWSER_PDF_VIEWER_HTML, BROWSER_PDF_VIEWER_MODULE } from './browserPdfViewerAssets'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
it.each([
  [
    'PDF source exceeds the 64 MiB input limit; open a smaller document',
    'PDF source exceeds the 64 MiB input limit; open a smaller document'
  ],
  [
    'PDF source changed while being read; close and reopen the document',
    'PDF source changed while being read; close and reopen the document'
  ],
  ['PDF session or source is no longer available', 'PDF session or source is no longer available'],
  ['<img src=x onerror=private()> private/path', 'Could not read the PDF document']
])('shows safe snapshot failure without starting the worker: %s', async (error, expected) => {
  document.open()
  document.write(BROWSER_PDF_VIEWER_HTML)
  document.close()
  delete document.documentElement.dataset.sidekickPdfReady
  delete document.documentElement.dataset.sidekickPdfError
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'fixture.pdf' }) })
    .mockResolvedValueOnce({ ok: false, json: async () => ({ error }) })
  vi.stubGlobal('fetch', fetcher)
  const worker = vi.fn()
  vi.stubGlobal('Worker', worker)
  const pdfjs = { getDocument: vi.fn(), PDFWorker: vi.fn() }
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const source = BROWSER_PDF_VIEWER_MODULE.replace(
    "import * as pdfjs from './pdf.mjs';",
    ''
  ).replace(/\nmain\(\);\s*$/, '')
  const run = new Function('pdfjs', source + '\nreturn main;')(pdfjs)
  await run()
  expect(document.querySelector('#status')?.textContent).toBe(expected)
  expect(document.documentElement.dataset.sidekickPdfError).toBe('true')
  expect(document.documentElement.dataset.sidekickPdfReady).toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(worker).not.toHaveBeenCalled()
  expect(pdfjs.getDocument).not.toHaveBeenCalled()
  expect(document.querySelector('#pages')?.childElementCount).toBe(0)
})
