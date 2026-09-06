export function fillablePdfFixture(): Buffer {
  const content = [
    'BT',
    '/F1 20 Tf',
    '72 720 Td',
    '(SideKick PDF Browser Smoke) Tj',
    '/F1 12 Tf',
    '0 -48 Td',
    '(Applicant name:) Tj',
    'ET'
  ].join('\n')
  const appearance = 'q 1 1 1 rg 0 0 300 24 re f 0 0 0 RG 0.8 w 0 0 300 24 re S Q'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [7 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Fields [7 0 R] /NeedAppearances true /DA (/F1 12 Tf 0 g) /DR << /Font << /F1 4 0 R >> >> >>',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (applicant_name) /TU (Applicant name) /Rect [180 638 480 662] /P 3 0 R /F 4 /V () /DA (/F1 12 Tf 0 g) /AP << /N 8 0 R >> >>',
    `<< /Type /XObject /Subtype /Form /BBox [0 0 300 24] /Resources << >> /Length ${Buffer.byteLength(appearance)} >>\nstream\n${appearance}\nendstream`
  ]
  let body = '%PDF-1.7\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body, 'ascii'))
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(body, 'ascii')
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'ascii')
}

/** Two-page AcroForm with text, export/display choice values, and a checkbox. */
export function multiFieldPdfFixture(): Buffer {
  const stream = (value: string, extra = '') =>
    `<< ${extra} /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream`
  const pageText = (second = false) =>
    `BT /F1 18 Tf 72 720 Td (Synthetic application - page ${second ? '2' : '1'}) Tj /F1 12 Tf 0 -72 Td (${second ? 'Reference note:' : 'Applicant name:'}) Tj ${second ? '' : '0 -60 Td (Priority:) Tj 0 -60 Td (Contact by email:) Tj'} ET`
  const off = 'q 1 1 1 rg 0 0 18 18 re f 0 0 0 RG 1 w 1 1 16 16 re S Q'
  const on = off + ' q 0 0 0 RG 2 w 3 3 m 15 15 l 3 15 m 15 3 l S Q'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 11 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [7 0 R 8 0 R 9 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(pageText()),
    '<< /Fields [7 0 R 8 0 R 9 0 R 13 0 R] /NeedAppearances true /DA (/F1 12 Tf 0 g) /DR << /Font << /F1 4 0 R >> >> >>',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (applicant_name) /TU (Applicant name) /Rect [180 638 480 662] /P 3 0 R /F 4 /V () /DA (/F1 12 Tf 0 g) >>',
    '<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /T (priority) /TU (Priority) /Opt [[(normal) (Normal)] [(high) (High)]] /V (normal) /Rect [180 578 480 602] /P 3 0 R /F 4 /DA (/F1 12 Tf 0 g) >>',
    '<< /Type /Annot /Subtype /Widget /FT /Btn /T (email_contact) /TU (Contact by email) /Rect [180 518 198 536] /P 3 0 R /F 4 /V /Off /AS /Off /AP << /N << /Off 10 0 R /Yes 14 0 R >> >> >>',
    stream(off, '/Type /XObject /Subtype /Form /BBox [0 0 18 18] /Resources << >>'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 12 0 R /Annots [13 0 R] >>',
    stream(pageText(true)),
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (reference_note) /TU (Reference note) /Rect [180 638 480 662] /P 11 0 R /F 4 /V () /DA (/F1 12 Tf 0 g) >>',
    stream(on, '/Type /XObject /Subtype /Form /BBox [0 0 18 18] /Resources << >>')
  ]
  let body = '%PDF-1.7\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'ascii'))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(body, 'ascii')
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'ascii')
}
