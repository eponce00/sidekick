import { expect, it } from 'vitest'
import { parseOfficeHelperReport, OFFICE_HELPER_OUTPUT_LIMIT } from './directOfficeHelperReport'
const parse = (data: unknown, code = 0) =>
  parseOfficeHelperReport('preflight', 'xlsx', Buffer.from(JSON.stringify(data)), false, code)
const available = {
  workflow: 'xlsx',
  status: 'available',
  checks: [{ kind: 'python', name: 'openpyxl', available: true }],
  note: 'PRIVATE_PATH'
}
it('adapts available and missing preflight reports without exporting helper strings', () => {
  expect(parse(available)).toEqual({
    evidence: 'helper_json_report',
    status: 'available',
    checks: 1,
    missing: 0
  })
  expect(
    parse(
      {
        ...available,
        status: 'missing_dependencies',
        checks: [{ kind: 'python', name: 'openpyxl', available: false }]
      },
      2
    )
  ).toMatchObject({ status: 'missing_dependencies', missing: 1 })
  expect(JSON.stringify(parse(available))).not.toContain('PRIVATE')
})
it('rejects spoofed, inconsistent and oversized output without changing process facts', () => {
  expect(parse(available, 9)).toMatchObject({ status: 'unusable_output', reason: 'exit_mismatch' })
  for (const value of [
    { ...available, checks: [] },
    { ...available, workflow: 'office' },
    { ...available, status: 'missing_dependencies' },
    { ...available, checks: [{ kind: 'python', name: 'PRIVATE', available: true }] }
  ])
    expect(parse(value)).toMatchObject({ status: 'unusable_output', reason: 'contract_mismatch' })
  expect(
    parseOfficeHelperReport(
      'preflight',
      'xlsx',
      Buffer.from('receipt: started\n{"status":"available"}'),
      false,
      0
    )
  ).toMatchObject({ reason: 'invalid_json' })
  expect(
    parseOfficeHelperReport(
      'preflight',
      'xlsx',
      Buffer.alloc(OFFICE_HELPER_OUTPUT_LIMIT + 1),
      false,
      0
    )
  ).toMatchObject({ reason: 'output_limit' })
  expect(parseOfficeHelperReport('preflight', 'xlsx', Buffer.from([0xff]), false, 0)).toMatchObject(
    { reason: 'invalid_json' }
  )
})
it('accepts both shipped structural report shapes and discards diagnostic content', () => {
  const valid = {
    valid: true,
    scope: 'opc-ooxml-structural',
    xsd_validation: false,
    parts_checked: 5,
    errors: [],
    warnings: ['PRIVATE_PATH']
  }
  const parse = (report: unknown, code: number) =>
    parseOfficeHelperReport('validate', undefined, Buffer.from(JSON.stringify(report)), false, code)
  expect(parse(valid, 0)).toEqual({
    evidence: 'helper_json_report',
    status: 'structurally_valid',
    errors: 0,
    warnings: 1,
    partsChecked: 5
  })
  expect(
    parse(
      {
        valid: false,
        scope: valid.scope,
        xsd_validation: false,
        errors: ['PRIVATE_XML'],
        warnings: []
      },
      1
    )
  ).toEqual({
    evidence: 'helper_json_report',
    status: 'structurally_invalid',
    errors: 1,
    warnings: 0
  })
  expect(parse({ ...valid, scope: 'xsd' }, 0)).toMatchObject({ reason: 'contract_mismatch' })
  expect(parse(valid, 1)).toMatchObject({ reason: 'exit_mismatch' })
  expect(parse({ ...valid, parts_checked: undefined }, 0)).toMatchObject({
    reason: 'contract_mismatch'
  })
})
