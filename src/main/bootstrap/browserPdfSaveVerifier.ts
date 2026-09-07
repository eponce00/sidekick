export interface PdfFieldExpectation {
  name: string
  type: 'Tx' | 'Ch' | 'checkbox' | 'radio'
  value: string | string[]
  widgets: { id: string; page: number }[]
}

interface FieldRecord {
  id: string
  type: string
  value: unknown
  page: number
  kidIds?: string[]
}

interface VerificationDocument {
  numPages: number
  getFieldObjects(): Promise<Map<string, FieldRecord[]> | null>
  getMetadata(): Promise<{ info: { IsXFAPresent?: boolean } }>
  getPage(page: number): Promise<{
    getAnnotations(options: { intent: string }): Promise<
      {
        id: string
        fieldName?: string
        fieldType?: string
        fieldValue?: unknown
        checkBox?: boolean
        radioButton?: boolean
      }[]
    >
  }>
}

interface VerifierApi {
  getDocument(options: { data: Uint8Array; worker: unknown; isEvalSupported: boolean }): {
    promise: Promise<VerificationDocument>
    destroy(): Promise<void>
  }
}

// Self-contained: serialized into the shipped viewer without another script route.
// Never log expected field names, contents, or parser errors.
export async function verifyBrowserPdfSave(
  pdfjs: VerifierApi,
  bytes: Uint8Array,
  worker: unknown,
  expected: PdfFieldExpectation[],
  originalXfa = false
): Promise<'acroform' | 'acroform-xfa-unverified'> {
  const failure = 'Could not verify saved PDF form values; no copy was saved'
  let task: ReturnType<VerifierApi['getDocument']> | undefined
  let scope: 'acroform' | 'acroform-xfa-unverified' | undefined
  let failed = false
  try {
    if (!expected.length) throw new Error(failure)
    // PDF.js transfers input data to its worker. Publication owns the original.
    task = pdfjs.getDocument({ data: bytes.slice(), worker, isEvalSupported: false })
    const document = await task.promise
    const fields = await document.getFieldObjects()
    if (!(fields instanceof Map)) throw new Error(failure)
    const pages = new Map<number, Awaited<ReturnType<VerificationDocument['getPage']>>>()
    const annotations = new Map<
      number,
      Awaited<ReturnType<Awaited<ReturnType<VerificationDocument['getPage']>>['getAnnotations']>>
    >()
    const equal = (actual: unknown, value: string | string[]): boolean =>
      Array.isArray(value)
        ? Array.isArray(actual) &&
          actual.length === value.length &&
          actual.every((item, index) => item === value[index])
        : actual === value
    const names = new Set<string>()
    for (const expectation of expected) {
      if (names.has(expectation.name) || !expectation.widgets.length) throw new Error(failure)
      names.add(expectation.name)
      const group = fields.get(expectation.name)
      if (!group?.length) throw new Error(failure)
      const byId = new Map(group.map((record) => [record.id, record]))
      if (byId.size !== group.length) throw new Error(failure)
      const checked = new Set<string>()
      const visit = (record: FieldRecord, ancestors = new Set<string>()): void => {
        if (ancestors.has(record.id)) throw new Error(failure)
        if (checked.has(record.id)) return
        if (record.type !== '') return
        // PDF.js includes non-widget parent nodes: no value, page -1, kidIds.
        // Their children's resolved values carry the inherited field value.
        if (record.page !== -1 || !record.kidIds?.length) throw new Error(failure)
        const next = new Set(ancestors).add(record.id)
        for (const id of record.kidIds) {
          const child = byId.get(id)
          if (!child) throw new Error(failure)
          visit(child, next)
        }
        checked.add(record.id)
      }
      group.forEach((record) => visit(record))
      const records = group.filter((record) => record.type !== '')
      if (!records.length) throw new Error(failure)
      const expectedTypes =
        expectation.type === 'Tx'
          ? ['text']
          : expectation.type === 'Ch'
            ? ['combobox', 'listbox']
            : expectation.type === 'radio'
              ? ['radiobutton']
              : ['checkbox']
      // getFieldObjects exposes only the first choice value, even for multiselect.
      const mapValue = Array.isArray(expectation.value)
        ? (expectation.value[0] ?? null)
        : expectation.value
      const ids = new Set<string>()
      for (const record of records) {
        if (
          !expectedTypes.includes(record.type) ||
          !equal(record.value, mapValue as string) ||
          ids.has(record.id)
        )
          throw new Error(failure)
        ids.add(record.id)
      }
      for (const widget of expectation.widgets) {
        if (!records.some((record) => record.id === widget.id && record.page === widget.page))
          throw new Error(failure)
      }
      // Check every widget in the canonical group, not only the edited radio.
      for (const record of records) {
        if (!Number.isInteger(record.page) || record.page < 0 || record.page >= document.numPages)
          throw new Error(failure)
        if (!pages.has(record.page)) pages.set(record.page, await document.getPage(record.page + 1))
        if (!annotations.has(record.page))
          annotations.set(
            record.page,
            await pages.get(record.page)!.getAnnotations({ intent: 'display' })
          )
        const matches = annotations.get(record.page)!.filter((item) => item.id === record.id)
        if (matches.length !== 1) throw new Error(failure)
        const widget = matches[0]
        const expectedType =
          expectation.type === 'checkbox' || expectation.type === 'radio' ? 'Btn' : expectation.type
        if (
          widget.fieldName !== expectation.name ||
          widget.fieldType !== expectedType ||
          (expectation.type === 'checkbox' && !widget.checkBox) ||
          (expectation.type === 'radio' && !widget.radioButton) ||
          !equal(widget.fieldValue, expectation.value)
        )
          throw new Error(failure)
      }
    }
    const metadata = await document.getMetadata()
    if (typeof metadata.info.IsXFAPresent !== 'boolean') throw new Error(failure)
    if (originalXfa && !metadata.info.IsXFAPresent) throw new Error(failure)
    scope = metadata.info.IsXFAPresent ? 'acroform-xfa-unverified' : 'acroform'
  } catch {
    failed = true
  } finally {
    try {
      // An explicitly supplied worker belongs to the viewer, not this task.
      await task?.destroy()
    } catch {
      failed = true
    }
  }
  if (failed || !scope) throw new Error(failure)
  return scope
}
