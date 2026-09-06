import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { BROWSER_PDF_VIEWER_HTML, BROWSER_PDF_VIEWER_MODULE } from './browserPdfViewerAssets'

// Optional existing PDF-lib runtime; no installation. File capture is separately opt-in.
const packagePath = process.env.SIDEKICK_PDF_LIB_PACKAGE
it.skipIf(!packagePath)(
  'round-trips checkbox on/off and radio switching through shipped handlers and PDF.js',
  async () => {
    const { PDFDocument } = createRequire(import.meta.url)(packagePath!)
    const source = await PDFDocument.create()
    const page = source.addPage([300, 200])
    const form = source.getForm()
    const check = form.createCheckBox('check')
    check.addToPage(page, { x: 20, y: 130, width: 20, height: 20 })
    const radio = form.createRadioGroup('radio')
    radio.addOptionToPage('First', page, { x: 60, y: 130, width: 20, height: 20 })
    radio.addOptionToPage('Second', page, { x: 100, y: 130, width: 20, height: 20 })
    radio.select('First')
    const original = new Uint8Array(await source.save())
    const retained = original.slice()
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = pdfjs.getDocument({ data: original.slice() })
    const pdf = await task.promise
    const dom = new JSDOM(BROWSER_PDF_VIEWER_HTML)
    const captureDirectory =
      process.env.SIDEKICK_PDF_BUTTON_CAPTURE === '1'
        ? await mkdtemp(join(tmpdir(), 'sidekick-pdf-button-qa-'))
        : undefined
    let captureIndex = 0
    try {
      const executable = BROWSER_PDF_VIEWER_MODULE.replace(
        "import * as pdfjs from './pdf.mjs';",
        ''
      ).replace(/\nmain\(\);\s*$/, '')
      const api = new Function(
        'document',
        'HTMLInputElement',
        'HTMLSelectElement',
        'testDocument',
        executable + '\npdfDocument = testDocument; return { createField, checkFormPermissions };'
      )(dom.window.document, dom.window.HTMLInputElement, dom.window.HTMLSelectElement, pdf)
      await api.checkFormPermissions()
      const annotations = await (await pdf.getPage(1)).getAnnotations()
      for (const annotation of annotations) {
        const element = api.createField(annotation, {
          convertToViewportPoint: (x: number, y: number) => [x, y]
        })
        if (element) dom.window.document.querySelector('#pages')!.append(element)
      }
      const box = dom.window.document.querySelector<HTMLInputElement>('input[type=checkbox]')!
      const radios = [
        ...dom.window.document.querySelectorAll<HTMLInputElement>('input[type=radio]')
      ]
      const change = (element: HTMLInputElement, checked: boolean) => {
        element.checked = checked
        element.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      }
      const verify = async (checked: boolean, selected: string) => {
        const bytes = await pdf.saveDocument()
        const reopened = await PDFDocument.load(bytes)
        expect(reopened.getForm().getCheckBox('check').isChecked()).toBe(checked)
        expect(reopened.getForm().getRadioGroup('radio').getSelected()).toBe(selected)
        for (const widget of reopened.getForm().getCheckBox('check').acroField.getWidgets()) {
          expect(widget.getAppearanceState().toString()).toBe(
            checked ? widget.getOnValue().toString() : '/Off'
          )
          expect(widget.getAppearances().normal).toBeTruthy()
        }
        for (const [index, widget] of reopened
          .getForm()
          .getRadioGroup('radio')
          .acroField.getWidgets()
          .entries()) {
          expect(widget.getAppearanceState().toString()).toBe(
            (index === 0 ? 'First' : 'Second') === selected
              ? widget.getOnValue().toString()
              : '/Off'
          )
          expect(widget.getAppearances().normal).toBeTruthy()
        }
        const task = pdfjs.getDocument({ data: bytes.slice() })
        try {
          const saved = await task.promise
          const fields = (await saved.getFieldObjects()) as Map<
            string,
            { type: string; value: string }[]
          > | null
          expect(
            fields
              ?.get('check')
              ?.filter((field: { type: string }) => field.type === 'checkbox')
              .map((field: { value: string }) => field.value)
          ).toEqual([checked ? 'Yes' : 'Off'])
          expect(
            fields
              ?.get('radio')
              ?.filter((field: { type: string }) => field.type === 'radiobutton')
              .map((field: { value: string }) => field.value)
          ).toEqual([selected, selected])
          if (captureDirectory) {
            const { createCanvas } = await import('@napi-rs/canvas')
            const page = await saved.getPage(1)
            const viewport = page.getViewport({ scale: 2 })
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
            await page.render({
              canvas: canvas as unknown as HTMLCanvasElement,
              canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
              viewport,
              annotationMode: pdfjs.AnnotationMode.ENABLE
            }).promise
            const name = `${++captureIndex}-${checked ? 'checked' : 'unchecked'}-${selected.toLowerCase()}`
            await writeFile(join(captureDirectory, `${name}.pdf`), bytes, { flag: 'wx' })
            await writeFile(join(captureDirectory, `${name}.png`), canvas.toBuffer('image/png'), {
              flag: 'wx'
            })
          }
        } finally {
          await task.destroy()
        }
      }
      change(box, true)
      await verify(true, 'First')
      change(box, false)
      await verify(false, 'First')
      change(radios[1], true)
      await verify(false, 'Second')
      change(radios[0], true)
      await verify(false, 'First')
      expect(original).toEqual(retained)
      if (captureDirectory) console.info('Synthetic button QA captures:', captureDirectory)
    } finally {
      dom.window.close()
      await task.destroy()
    }
  },
  30000
)
