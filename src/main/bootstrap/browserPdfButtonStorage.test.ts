// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { BROWSER_PDF_VIEWER_HTML, BROWSER_PDF_VIEWER_MODULE } from './browserPdfViewerAssets'

it('stores per-widget booleans and clears only siblings in the selected radio group', async () => {
  document.open()
  document.write(BROWSER_PDF_VIEWER_HTML)
  document.close()
  const setValue = vi.fn()
  const executable = BROWSER_PDF_VIEWER_MODULE.replace(
    "import * as pdfjs from './pdf.mjs';",
    ''
  ).replace(/\nmain\(\);\s*$/, '')
  const api = new Function(
    'testDocument',
    executable + '\npdfDocument = testDocument; return { createField, checkFormPermissions };'
  )({ annotationStorage: { setValue }, getPermissions: async () => null })
  await api.checkFormPermissions()
  const field = (id: string, name: string, radio: boolean, exportValue: string) => {
    const element = api.createField(
      {
        id,
        fieldName: name,
        fieldType: 'Btn',
        checkBox: !radio,
        radioButton: radio,
        buttonValue: exportValue,
        exportValue,
        fieldValue: 'Off',
        rect: [0, 0, 20, 20]
      },
      { convertToViewportPoint: (x: number, y: number) => [x, y] }
    ) as HTMLInputElement
    document.querySelector('#pages')!.append(element)
    return element
  }
  const checkbox = field('c', 'check', false, 'CustomOn')
  const first = field('a', 'group["name', true, 'ExportA')
  const second = field('b', 'group["name', true, 'ExportB')
  field('other', 'different', true, 'ExportA')
  const change = (element: HTMLInputElement, checked: boolean) => {
    element.checked = checked
    element.dispatchEvent(new Event('change'))
  }
  change(checkbox, true)
  expect(setValue).toHaveBeenLastCalledWith('c', { value: true })
  change(checkbox, false)
  expect(setValue).toHaveBeenLastCalledWith('c', { value: false })
  change(second, true)
  expect(setValue).toHaveBeenCalledWith('a', { value: false })
  expect(setValue).toHaveBeenCalledWith('b', { value: true })
  setValue.mockClear()
  change(first, true)
  expect(setValue).toHaveBeenCalledWith('a', { value: true })
  expect(setValue).toHaveBeenCalledWith('b', { value: false })
  expect(setValue.mock.calls.every(([id]) => id !== 'other')).toBe(true)
  expect(checkbox.value).toBe('CustomOn')
  expect(first.value).toBe('ExportA')
})
