import { expect, it, vi } from 'vitest'
import { verifyBrowserPdfSave, type PdfFieldExpectation } from './browserPdfSaveVerifier'

function fixture(type: PdfFieldExpectation['type'] = 'Tx', value: string | string[] = 'updated') {
  const recordType = { Tx: 'text', Ch: 'listbox', checkbox: 'checkbox', radio: 'radiobutton' }[type]
  const expected: PdfFieldExpectation[] = [
    { name: 'fixture', type, value, widgets: [{ id: '1R', page: 0 }] }
  ]
  const fields = new Map([
    [
      'fixture',
      [
        {
          id: '1R',
          page: 0,
          type: recordType,
          value: Array.isArray(value) ? (value[0] ?? null) : value
        }
      ]
    ]
  ])
  const widgets = [
    {
      id: '1R',
      fieldName: 'fixture',
      fieldType: type === 'radio' || type === 'checkbox' ? 'Btn' : type,
      fieldValue: value,
      checkBox: type === 'checkbox',
      radioButton: type === 'radio'
    }
  ]
  const document = {
    numPages: 1,
    getFieldObjects: vi.fn(async () => fields),
    getMetadata: vi.fn(async () => ({ info: { IsXFAPresent: false } })),
    getPage: vi.fn(async () => ({ getAnnotations: vi.fn(async () => widgets) }))
  }
  const destroy = vi.fn(async () => {})
  const api = { getDocument: vi.fn(() => ({ promise: Promise.resolve(document), destroy })) }
  const bytes = new Uint8Array([37, 80, 68, 70, 45])
  return { api, document, destroy, expected, fields, widgets, bytes }
}

it.each(['Tx', 'Ch', 'checkbox', 'radio'] as const)(
  'checks Map and widgets for %s',
  async (type) => {
    const f = fixture(type, type === 'Ch' ? ['a', 'b'] : type === 'checkbox' ? 'Off' : 'updated')
    expect(await verifyBrowserPdfSave(f.api, f.bytes, {}, f.expected)).toBe('acroform')
    expect(f.destroy).toHaveBeenCalledOnce()
  }
)

it.each([
  'map-value',
  'widget-value',
  'missing',
  'identity',
  'duplicate',
  'type',
  'page',
  'no-expectations'
])('rejects %s and destroys the task', async (mode) => {
  const f = fixture()
  if (mode === 'map-value') f.fields.get('fixture')![0].value = 'stale'
  if (mode === 'widget-value') f.widgets[0].fieldValue = 'stale'
  if (mode === 'missing') f.fields.clear()
  if (mode === 'identity') f.widgets[0].id = 'another'
  if (mode === 'duplicate') f.widgets.push({ ...f.widgets[0] })
  if (mode === 'type') f.widgets[0].fieldType = 'Btn'
  if (mode === 'page') f.fields.get('fixture')![0].page = -1
  if (mode === 'no-expectations') f.expected.length = 0
  await expect(verifyBrowserPdfSave(f.api, f.bytes, {}, f.expected)).rejects.toThrow(
    'Could not verify saved PDF form values; no copy was saved'
  )
  expect(f.destroy).toHaveBeenCalledTimes(mode === 'no-expectations' ? 0 : 1)
})

it('checks the full multiselect array rather than only the Map first value', async () => {
  const f = fixture('Ch', ['first', 'second'])
  f.widgets[0].fieldValue = ['first', 'stale']
  await expect(verifyBrowserPdfSave(f.api, f.bytes, {}, f.expected)).rejects.toThrow(
    'Could not verify'
  )
})

it('checks unedited radio siblings in the canonical group', async () => {
  const f = fixture('radio', 'selected')
  f.fields.get('fixture')!.push({ ...f.fields.get('fixture')![0], id: '2R' })
  f.widgets.push({ ...f.widgets[0], id: '2R', fieldValue: 'stale' })
  await expect(verifyBrowserPdfSave(f.api, f.bytes, {}, f.expected)).rejects.toThrow(
    'Could not verify'
  )
})

it('labels hybrid scope without claiming XFA dataset verification', async () => {
  const f = fixture()
  f.document.getMetadata.mockResolvedValue({ info: { IsXFAPresent: true } })
  expect(await verifyBrowserPdfSave(f.api, f.bytes, {}, f.expected)).toBe('acroform-xfa-unverified')
})

it('rejects loss of source XFA metadata instead of upgrading the verification claim', async () => {
  const f = fixture()
  await expect(verifyBrowserPdfSave(f.api, f.bytes, {}, f.expected, true)).rejects.toThrow(
    'Could not verify'
  )
})

it.each(['valid', 'missing-child', 'cycle'])(
  'validates non-widget parent nodes: %s',
  async (mode) => {
    const f = fixture()
    const group = f.fields.get('fixture')! as {
      id: string
      page: number
      type: string
      value: unknown
      kidIds?: string[]
    }[]
    group.unshift({
      id: 'parent',
      page: -1,
      type: '',
      value: undefined,
      kidIds: [mode === 'cycle' ? 'parent' : mode === 'missing-child' ? 'absent' : '1R']
    })
    const result = verifyBrowserPdfSave(f.api, f.bytes, {}, f.expected)
    if (mode === 'valid') await expect(result).resolves.toBe('acroform')
    else await expect(result).rejects.toThrow('Could not verify')
  }
)

it.each(['parse', 'metadata', 'cleanup'])(
  'fails closed on %s without leaking parser details',
  async (mode) => {
    const f = fixture()
    const error = new Error('private field value and path')
    if (mode === 'parse')
      f.api.getDocument.mockReturnValue({ promise: Promise.reject(error), destroy: f.destroy })
    if (mode === 'metadata') f.document.getMetadata.mockRejectedValue(error)
    if (mode === 'cleanup') f.destroy.mockRejectedValue(error)
    await expect(verifyBrowserPdfSave(f.api, f.bytes, {}, f.expected)).rejects.toThrow(
      'Could not verify saved PDF form values; no copy was saved'
    )
    expect(f.destroy).toHaveBeenCalledOnce()
  }
)

it('passes an independent transferable copy and never destroys the supplied worker', async () => {
  const f = fixture()
  const worker = { destroy: vi.fn() }
  const original = f.bytes.slice()
  const getDocument = (options: { data: Uint8Array; worker: unknown }) => {
    expect(options.worker).toBe(worker)
    structuredClone(options.data, { transfer: [options.data.buffer] })
    expect(options.data.byteLength).toBe(0)
    return { promise: Promise.resolve(f.document), destroy: f.destroy }
  }
  await verifyBrowserPdfSave({ getDocument }, f.bytes, worker, f.expected)
  expect(f.bytes).toEqual(original)
  expect(worker.destroy).not.toHaveBeenCalled()
})
