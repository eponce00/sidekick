// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { BROWSER_PDF_VIEWER_HTML, BROWSER_PDF_VIEWER_MODULE } from './browserPdfViewerAssets'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function fixture() {
  document.open()
  document.write(BROWSER_PDF_VIEWER_HTML)
  document.close()
  delete document.documentElement.dataset.sidekickPdfSaved
  delete document.documentElement.dataset.sidekickPdfOutput
  const source = new Uint8Array([1, 2, 3])
  const pdf = {
    getMetadata: async () => ({ info: { IsXFAPresent: false } }),
    getPermissions: async () => null,
    annotationStorage: { setValue: vi.fn() },
    saveDocument: vi.fn(async (): Promise<Uint8Array> => {
      const copy = source.slice()
      copy[0] = 4
      return copy
    })
  }
  // Execute the shipped module's actual field/save handlers; replace only external loading.
  const executable = BROWSER_PDF_VIEWER_MODULE.replace("import * as pdfjs from './pdf.mjs';", '')
    .replace(/\nmain\(\);\s*$/, '')
    .replace(
      // This suite isolates revision/publication races; real verification has its
      // own failure and round-trip tests rather than parsing these synthetic bytes.
      'const verificationScope = await verifySavedForm(pdfjs, bytes, viewerWorker, expected, sourceXfa);',
      "const verificationScope = 'acroform'; void expected;"
    )
  const api = new Function(
    'pdfjs',
    'testDocument',
    executable + '\npdfDocument = testDocument; return { createField, checkFormPermissions };'
  )({}, pdf)
  await api.checkFormPermissions()
  const field = api.createField(
    { id: 'field1', fieldName: 'Name', fieldType: 'Tx', fieldValue: '', rect: [0, 0, 80, 20] },
    { convertToViewportPoint: (x: number, y: number) => [x, y] }
  ) as HTMLInputElement
  document.querySelector('#pages')!.append(field)
  const edit = (value: string) => {
    field.value = value
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const button = document.querySelector<HTMLButtonElement>('#save')!
  return { source, pdf, edit, button }
}

afterEach(() => vi.unstubAllGlobals())

it.each(['serialization', 'network'] as const)(
  'keeps edits during %s unsaved and permits a subsequent save',
  async (stage) => {
    const { source, pdf, edit, button } = await fixture()
    const saved = deferred<Uint8Array>()
    const response = deferred<Response>()
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response.promise)
      .mockResolvedValue({
        ok: true,
        json: async () => ({ outputPath: '/synthetic/new-copy.pdf' })
      })
    vi.stubGlobal('fetch', fetcher)
    pdf.saveDocument.mockImplementationOnce(() => saved.promise)
    edit('first')
    button.click()
    if (stage === 'network') {
      saved.resolve(new Uint8Array([4]))
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    }
    edit('newer')
    button.dispatchEvent(new Event('click'))
    expect(pdf.saveDocument).toHaveBeenCalledTimes(1)
    saved.resolve(new Uint8Array([4]))
    response.resolve({
      ok: true,
      json: async () => ({ outputPath: '/synthetic/older-copy.pdf' })
    } as Response)
    await vi.waitFor(() =>
      expect(document.documentElement.dataset.sidekickPdfOutput).toBe('/synthetic/older-copy.pdf')
    )
    expect(document.documentElement.dataset.sidekickPdfSaved).toBe('false')
    expect(document.querySelector('#status')!.textContent).toContain('Unsaved')
    expect(button.disabled).toBe(false)
    button.click()
    await vi.waitFor(() => expect(document.documentElement.dataset.sidekickPdfSaved).toBe('true'))
    expect(document.documentElement.dataset.sidekickPdfOutput).toBe('/synthetic/new-copy.pdf')
    expect(button.disabled).toBe(true)
    expect(source).toEqual(new Uint8Array([1, 2, 3]))
    expect(
      fetcher.mock.calls.every(([url, options]) => url === './save' && options.method === 'POST')
    ).toBe(true)
  }
)

it('clears the saved marker after a later edit while keeping the previous copy path accessible', async () => {
  const { edit, button } = await fixture()
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ outputPath: '/synthetic/saved.pdf' }) })
  )
  edit('first')
  button.click()
  await vi.waitFor(() => expect(document.documentElement.dataset.sidekickPdfSaved).toBe('true'))
  edit('second')
  expect(document.documentElement.dataset.sidekickPdfSaved).toBe('false')
  expect(document.documentElement.dataset.sidekickPdfOutput).toBe('/synthetic/saved.pdf')
  expect(button.disabled).toBe(false)
})

it.each(['serialization', 'network'] as const)(
  'preserves dirty edits and permits retry after %s failure',
  async (stage) => {
    const { pdf, edit, button } = await fixture()
    const response = deferred<Response>()
    const saved = deferred<Uint8Array>()
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response.promise)
      .mockResolvedValue({ ok: true, json: async () => ({ outputPath: '/synthetic/retried.pdf' }) })
    vi.stubGlobal('fetch', fetcher)
    if (stage === 'serialization') pdf.saveDocument.mockImplementationOnce(() => saved.promise)
    edit('first')
    button.click()
    edit('newer')
    if (stage === 'serialization') saved.reject(new Error('Synthetic serialization failure'))
    else response.reject(new Error('Synthetic network failure'))
    await vi.waitFor(() => expect(button.disabled).toBe(false))
    expect(document.documentElement.dataset.sidekickPdfSaved).toBe('false')
    expect(document.querySelector('#status')!.getAttribute('data-kind')).toBe('error')
    if (stage === 'serialization')
      fetcher.mockReset().mockResolvedValue({
        ok: true,
        json: async () => ({ outputPath: '/synthetic/retried.pdf' })
      })
    button.click()
    await vi.waitFor(() => expect(document.documentElement.dataset.sidekickPdfSaved).toBe('true'))
    expect(document.documentElement.dataset.sidekickPdfOutput).toBe('/synthetic/retried.pdf')
  }
)
