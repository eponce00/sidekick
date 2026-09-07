// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { BROWSER_PDF_VIEWER_HTML, BROWSER_PDF_VIEWER_MODULE } from './browserPdfViewerAssets'

afterEach(() => vi.unstubAllGlobals())

async function fixture() {
  document.open()
  document.write(BROWSER_PDF_VIEWER_HTML)
  document.close()
  const original = new Uint8Array([37, 80, 68, 70, 45])
  const saved = {
    numPages: 1,
    getFieldObjects: vi.fn(
      async () => new Map([['fixture', [{ id: '1R', type: 'text', value: 'updated', page: 0 }]]])
    ),
    getMetadata: vi.fn(async () => ({ info: { IsXFAPresent: false } })),
    getPage: vi.fn(async () => ({
      getAnnotations: async () => [
        { id: '1R', fieldName: 'fixture', fieldType: 'Tx', fieldValue: 'updated' }
      ]
    }))
  }
  const destroy = vi.fn(async () => {})
  const pdfjs = { getDocument: vi.fn(() => ({ promise: Promise.resolve(saved), destroy })) }
  const pdf = {
    getMetadata: async () => ({ info: { IsXFAPresent: false } }),
    getPermissions: async () => null,
    annotationStorage: { setValue: vi.fn() },
    saveDocument: vi.fn(async () => original)
  }
  let source = BROWSER_PDF_VIEWER_MODULE.replace("import * as pdfjs from './pdf.mjs';", '').replace(
    /\nmain\(\);\s*$/,
    ''
  )
  if (process.env.SIDEKICK_PDF_VERIFY_OLD_FLOW === '1')
    source = source.replace(
      'const verificationScope = await verifySavedForm(pdfjs, bytes, viewerWorker, expected, sourceXfa);',
      "const verificationScope = 'acroform';"
    )
  const api = new Function(
    'pdfjs',
    'testDocument',
    source + '\npdfDocument=testDocument; return {createField,checkFormPermissions};'
  )(pdfjs, pdf)
  await api.checkFormPermissions()
  const field = api.createField(
    { id: '1R', fieldName: 'fixture', fieldType: 'Tx', fieldValue: '', rect: [0, 0, 80, 20] },
    { convertToViewportPoint: (x: number, y: number) => [x, y] }
  ) as HTMLInputElement
  document.querySelector('#pages')!.append(field)
  const edit = (value: string) => {
    field.value = value
    field.dispatchEvent(new Event('input'))
  }
  const fetcher = vi.fn(async () => ({
    ok: true,
    json: async () => ({ outputPath: '/synthetic/verified.pdf' })
  }))
  vi.stubGlobal('fetch', fetcher)
  const click = () => document.querySelector<HTMLButtonElement>('#save')!.click()
  return { saved, pdf, pdfjs, destroy, edit, click, fetcher, original }
}

it('does not POST or mark saved when serialization returns unchanged stale values', async () => {
  const f = await fixture()
  f.saved.getFieldObjects.mockResolvedValue(
    new Map([['fixture', [{ id: '1R', type: 'text', value: '', page: 0 }]]])
  )
  f.edit('updated')
  f.click()
  await vi.waitFor(() =>
    expect(document.querySelector('#status')?.textContent).toBe(
      'Could not verify saved PDF form values; no copy was saved'
    )
  )
  expect(f.fetcher).not.toHaveBeenCalled()
  expect(document.documentElement.dataset.sidekickPdfSaved).toBe('false')
})

it('keeps newer edits dirty while posting only the verified earlier bytes', async () => {
  const f = await fixture()
  let resolve!: () => void
  const pending = new Promise<void>((yes) => {
    resolve = yes
  })
  f.saved.getFieldObjects.mockImplementation(async () => {
    await pending
    return new Map([['fixture', [{ id: '1R', type: 'text', value: 'updated', page: 0 }]]])
  })
  f.edit('updated')
  f.click()
  f.edit('newer')
  resolve()
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce())
  expect(document.documentElement.dataset.sidekickPdfSaved).toBe('false')
  expect(document.querySelector('#status')?.textContent).toContain('Unsaved newer form changes')
  expect((f.fetcher.mock.calls as unknown as [string, { body: Uint8Array }][])[0][1].body).toBe(
    f.original
  )
  expect(f.destroy).toHaveBeenCalledOnce()
})

it('publishes hybrid copies with explicit machine-readable and displayed scope', async () => {
  const f = await fixture()
  f.saved.getMetadata.mockResolvedValue({ info: { IsXFAPresent: true } })
  f.edit('updated')
  f.click()
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce())
  expect(document.documentElement.dataset.sidekickPdfVerification).toBe('acroform-xfa-unverified')
  expect(document.querySelector('#status')?.textContent).toContain(
    'AcroForm verified; XFA compatibility unverified'
  )
})
