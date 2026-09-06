import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { verifyBrowserPdfSave, type PdfFieldExpectation } from './browserPdfSaveVerifier'

const packagePath = process.env.SIDEKICK_PDF_LIB_PACKAGE
it.skipIf(!packagePath).each(['', 'first'])(
  'verifies real single-choice saves from initial selection %j',
  async (initial) => {
    const { PDFDocument } = createRequire(import.meta.url)(packagePath!)
    const source = await PDFDocument.create()
    const page = source.addPage([300, 200])
    const dropdown = source.getForm().createDropdown('single')
    dropdown.setOptions(['', 'first', 'second'])
    if (initial) dropdown.select(initial)
    dropdown.addToPage(page, { x: 20, y: 100, width: 160, height: 30 })
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const worker = new pdfjs.PDFWorker()
    const task = pdfjs.getDocument({ data: new Uint8Array(await source.save()), worker })
    try {
      const document = await task.promise
      const annotation = (await (await document.getPage(1)).getAnnotations()).find(
        (a) => a.fieldName === 'single'
      )!
      expect(annotation.multiSelect).toBe(false)
      expect(annotation.fieldValue).toEqual(initial ? [initial] : [])
      for (const selected of ['second', '']) {
        // Exactly the viewer's ordinary single-select annotationStorage shape.
        document.annotationStorage.setValue(annotation.id, { value: selected })
        const bytes = await document.saveDocument()
        await expect(
          verifyBrowserPdfSave(
            pdfjs as unknown as Parameters<typeof verifyBrowserPdfSave>[0],
            bytes,
            worker,
            [
              {
                name: 'single',
                type: 'Ch',
                value: [selected],
                widgets: [{ id: annotation.id, page: 0 }]
              }
            ]
          )
        ).resolves.toBe('acroform')
      }
    } finally {
      await task.destroy()
      worker.destroy()
    }
  },
  30000
)
it.skipIf(!packagePath)(
  'verifies actual serialized text/multiselect/buttons and preserves the shared worker',
  async () => {
    const { PDFDocument } = createRequire(import.meta.url)(packagePath!)
    const source = await PDFDocument.create()
    const page = source.addPage([400, 400])
    const form = source.getForm()
    form.createTextField('text').addToPage(page, { x: 20, y: 300, width: 160, height: 20 })
    const choices = form.createOptionList('choices')
    choices.setOptions(['first', 'second', 'third'])
    choices.enableMultiselect()
    choices.addToPage(page, { x: 20, y: 200, width: 160, height: 60 })
    form.createCheckBox('box').addToPage(page, { x: 20, y: 150, width: 20, height: 20 })
    const radio = form.createRadioGroup('radio')
    radio.addOptionToPage('first', page, { x: 20, y: 100, width: 20, height: 20 })
    radio.addOptionToPage('second', page, { x: 60, y: 100, width: 20, height: 20 })
    radio.select('first')
    const original = new Uint8Array(await source.save())
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const worker = new pdfjs.PDFWorker()
    const options = { data: original.slice(), worker, isEvalSupported: false }
    const task = pdfjs.getDocument(options)
    try {
      const doc = await task.promise
      const annotations = await (await doc.getPage(1)).getAnnotations()
      const expected: PdfFieldExpectation[] = []
      for (const [name, type, value] of [
        ['text', 'Tx', 'updated'],
        ['choices', 'Ch', ['first', 'third']],
        ['box', 'checkbox', 'Yes'],
        ['radio', 'radio', 'second']
      ] as const) {
        const members = annotations.filter((a) => a.fieldName === name)
        expect(members.length).toBeGreaterThan(0)
        for (const a of members)
          doc.annotationStorage.setValue(a.id, {
            value:
              type === 'checkbox'
                ? true
                : type === 'radio'
                  ? a.buttonValue === 'second'
                  : Array.isArray(value)
                    ? [...value]
                    : value
          })
        expected.push({
          name,
          type,
          value: Array.isArray(value) ? [...value] : (value as string),
          widgets: members.map((a) => ({ id: a.id, page: 0 }))
        })
      }
      // An unchanged serialized source must not satisfy the changed expectations.
      await expect(
        verifyBrowserPdfSave(
          pdfjs as unknown as Parameters<typeof verifyBrowserPdfSave>[0],
          original,
          worker,
          expected
        )
      ).rejects.toThrow('Could not verify')
      const bytes = await doc.saveDocument()
      const retained = bytes.slice()
      expect(
        await verifyBrowserPdfSave(
          pdfjs as unknown as Parameters<typeof verifyBrowserPdfSave>[0],
          bytes,
          worker,
          expected
        )
      ).toBe('acroform')
      expect(bytes).toEqual(retained)
      // Destroying the verifier's task must not destroy the viewer's supplied worker.
      expect((await (await doc.getPage(1)).getAnnotations()).length).toBe(annotations.length)
    } finally {
      await task.destroy()
      worker.destroy()
    }
  },
  30000
)
