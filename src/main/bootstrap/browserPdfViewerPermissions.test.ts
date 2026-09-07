// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { BROWSER_PDF_VIEWER_HTML, BROWSER_PDF_VIEWER_MODULE } from './browserPdfViewerAssets'

const flags = { MODIFY_ANNOTATIONS: 32, FILL_INTERACTIVE_FORMS: 256 }

function fixture(getPermissions: () => Promise<Set<number> | null>) {
  document.open()
  document.write(BROWSER_PDF_VIEWER_HTML)
  document.close()
  const pdf = {
    getPermissions,
    annotationStorage: { setValue: vi.fn() },
    saveDocument: vi.fn(async () => new Uint8Array([1]))
  }
  const source = BROWSER_PDF_VIEWER_MODULE.replace(
    "import * as pdfjs from './pdf.mjs';",
    ''
  ).replace(/\nmain\(\);\s*$/, '')
  const api = new Function(
    'pdfjs',
    'testDocument',
    source +
      `
    pdfDocument = testDocument;
    return { checkFormPermissions, createField, permissionMessage: () => permissionMessage };
  `
  )({ PermissionFlag: flags }, pdf)
  const field = (readOnly = false) =>
    api.createField(
      {
        id: 'fixture',
        fieldName: 'Fixture',
        fieldType: 'Tx',
        fieldValue: '',
        readOnly,
        rect: [0, 0, 80, 20]
      },
      { convertToViewportPoint: (x: number, y: number) => [x, y] }
    ) as HTMLInputElement
  return { api, pdf, field, save: document.querySelector<HTMLButtonElement>('#save')! }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each([
  [null, true],
  [[], false],
  [[4], false],
  [[32], true],
  [[256], true],
  [[32, 256], true]
] as const)('enforces document permissions %j with editing=%s', async (values, allowed) => {
  const f = fixture(async () => (values === null ? null : new Set(values)))
  await f.api.checkFormPermissions()
  const field = f.field()
  expect(field.disabled).toBe(!allowed)
  field.value = 'synthetic'
  field.dispatchEvent(new Event('input'))
  expect(f.pdf.annotationStorage.setValue).toHaveBeenCalledTimes(allowed ? 1 : 0)
  expect(f.save.disabled).toBe(!allowed)
  if (!allowed) {
    f.save.dispatchEvent(new Event('click'))
    expect(f.pdf.saveDocument).not.toHaveBeenCalled()
    expect(f.api.permissionMessage()).toContain('does not permit')
  }
})

it.each([null, new Set([32, 256])])('preserves field-level readOnly', async (permissions) => {
  const f = fixture(async () => permissions)
  await f.api.checkFormPermissions()
  const field = f.field(true)
  expect(field.disabled).toBe(true)
  field.dispatchEvent(new Event('change'))
  expect(f.pdf.annotationStorage.setValue).not.toHaveBeenCalled()
  expect(f.save.disabled).toBe(true)
})

it.each(['reject', 'invalid'])('fails closed with a fixed message on %s', async (mode) => {
  const f = fixture(async () => {
    if (mode === 'reject') throw new Error('private/path/or/secret')
    return undefined as unknown as null
  })
  await f.api.checkFormPermissions()
  const field = f.field()
  expect(field.disabled).toBe(true)
  field.dispatchEvent(new Event('input'))
  f.save.dispatchEvent(new Event('click'))
  expect(f.pdf.annotationStorage.setValue).not.toHaveBeenCalled()
  expect(f.pdf.saveDocument).not.toHaveBeenCalled()
  expect(f.api.permissionMessage()).toBe('Read-only — could not verify PDF form permissions')
})

it('does not allow editing while the permission request is pending', async () => {
  let resolve!: (value: null) => void
  const f = fixture(
    () =>
      new Promise<null>((yes) => {
        resolve = yes
      })
  )
  const pending = f.api.checkFormPermissions()
  const field = f.field()
  expect(field.disabled).toBe(true)
  field.dispatchEvent(new Event('input'))
  expect(f.pdf.annotationStorage.setValue).not.toHaveBeenCalled()
  resolve(null)
  await pending
  expect(f.field().disabled).toBe(false)
})

it('shows the fixed permission failure in the actual main loading path', async () => {
  document.open()
  document.write(BROWSER_PDF_VIEWER_HTML)
  document.close()
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'fixture.pdf' }) })
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })
    .mockResolvedValueOnce({ ok: true, text: async () => '' })
  vi.stubGlobal('fetch', fetcher)
  vi.stubGlobal('Worker', class {})
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:fixture' })
  const pdf = {
    numPages: 0,
    getPermissions: async () => {
      throw new Error('private fixture detail')
    }
  }
  const source = BROWSER_PDF_VIEWER_MODULE.replace(
    "import * as pdfjs from './pdf.mjs';",
    ''
  ).replace(/\nmain\(\);\s*$/, '')
  const main = new Function('pdfjs', source + '\nreturn main;')({
    PermissionFlag: flags,
    PDFWorker: class {},
    getDocument: () => ({ promise: Promise.resolve(pdf) })
  })
  await main()
  expect(document.querySelector('#status')?.textContent).toBe(
    'Read-only — could not verify PDF form permissions'
  )
  expect(document.querySelector<HTMLButtonElement>('#save')?.disabled).toBe(true)
})
