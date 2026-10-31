import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { readPdf } from './pdfReader'

// A page of text, then a page that is only a picture, as a scanner makes it.
function textThenScanPdf(): Buffer {
  const text = 'BT /F1 12 Tf 72 720 Td (Quarterly revenue rose in every region.) Tj ET'
  const scan = 'q 612 0 0 792 0 0 cm /Im1 Do Q'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 8 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${scan.length} >>\nstream\n${scan}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n\u0000\u00ff\u00ff\u0000\nendstream'
  ]
  let body = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body, 'latin1')
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

describe('PDF reading', () => {
  it('recognizes a scanned page with OCR when the model reads text only', async () => {
    const recognize = vi.fn(async (paths: readonly string[]) => ({
      ok: true as const,
      texts: paths.map(() => 'INVOICE 4471')
    }))
    const result = await readPdf(textThenScanPdf(), {
      maxTokens: 10_000,
      imageBudget: 0,
      label: 'report.pdf',
      recognize
    })
    expect(result.content).toContain('Quarterly revenue rose in every region.')
    expect(result.content).toContain(
      '--- Page 2 of 2 (scanned: no text layer; text recognized by OCR) ---\nINVOICE 4471'
    )
    expect(recognize).toHaveBeenCalledOnce()
    expect(result.media).toEqual([])
  })

  it('shows a scanned page to a model that can see, and keeps its words as text', async () => {
    const recognize = vi.fn(async (paths: readonly string[]) => ({
      ok: true as const,
      texts: paths.map(() => 'INVOICE 4471')
    }))
    const result = await readPdf(textThenScanPdf(), {
      maxTokens: 10_000,
      imageBudget: 2,
      label: 'report.pdf',
      recognize
    })
    expect(result.content).toContain(
      '--- Page 2 of 2 (scanned: no text layer; text recognized by OCR; page image attached) ---\nINVOICE 4471'
    )
    expect(result.media).toMatchObject([
      { type: 'image', mimeType: 'image/jpeg', name: 'report.pdf page 2' }
    ])
  })
})
