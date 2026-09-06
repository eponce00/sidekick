export const OFFICE_HELPER_OUTPUT_LIMIT = 64 * 1024
type UnusableReason =
  | 'output_limit'
  | 'invalid_json'
  | 'contract_mismatch'
  | 'exit_mismatch'
  | 'stream_error'
export type OfficeHelperReport = Readonly<
  | { evidence: 'helper_json_report'; status: 'unusable_output'; reason: UnusableReason }
  | {
      evidence: 'helper_json_report'
      status: 'available' | 'missing_dependencies'
      checks: number
      missing: number
    }
  | {
      evidence: 'helper_json_report'
      status: 'structurally_valid' | 'structurally_invalid'
      errors: number
      warnings: number
      partsChecked?: number
    }
>
const requirements: Record<string, readonly string[]> = {
  office: ['python:defusedxml', 'python:lxml'],
  'office-validate': ['python:lxml', 'bundled-asset:office/structure.py'],
  'docx-comment': ['python:lxml'],
  xlsx: ['python:openpyxl'],
  'pptx-read': ['python:python-pptx']
}
/** Content report only. Process identity/lifecycle never comes from this parser. */
export function parseOfficeHelperReport(
  helper: 'preflight' | 'validate',
  workflow: string | undefined,
  bytes: Buffer,
  overflow: boolean,
  exitCode: number | null
): OfficeHelperReport {
  const bad = (reason: UnusableReason): OfficeHelperReport =>
    Object.freeze({ evidence: 'helper_json_report', status: 'unusable_output', reason })
  if (overflow || bytes.length > OFFICE_HELPER_OUTPUT_LIMIT) return bad('output_limit')
  let report
  try {
    report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return bad('invalid_json')
  }
  if (!report || typeof report !== 'object' || Array.isArray(report))
    return bad('contract_mismatch')
  if (helper === 'preflight') {
    const expected =
      workflow && Object.hasOwn(requirements, workflow) ? requirements[workflow] : undefined
    if (
      !expected ||
      report.workflow !== workflow ||
      !Array.isArray(report.checks) ||
      report.checks.length !== expected.length
    )
      return bad('contract_mismatch')
    const remaining = new Set(expected)
    let missing = 0
    for (const check of report.checks) {
      if (
        !check ||
        typeof check !== 'object' ||
        typeof check.available !== 'boolean' ||
        typeof check.kind !== 'string' ||
        typeof check.name !== 'string' ||
        !remaining.delete(`${check.kind}:${check.name}`)
      )
        return bad('contract_mismatch')
      if (!check.available) missing++
    }
    const status = missing ? 'missing_dependencies' : 'available'
    if (report.status !== status) return bad('contract_mismatch')
    if (exitCode !== (missing ? 2 : 0)) return bad('exit_mismatch')
    return Object.freeze({
      evidence: 'helper_json_report',
      status,
      checks: expected.length,
      missing
    })
  }
  const messages = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length <= 100 && value.every((item) => typeof item === 'string')
  if (
    typeof report.valid !== 'boolean' ||
    report.scope !== 'opc-ooxml-structural' ||
    report.xsd_validation !== false ||
    !messages(report.errors) ||
    !messages(report.warnings) ||
    report.valid !== (report.errors.length === 0) ||
    (report.valid && report.parts_checked === undefined) ||
    (report.parts_checked !== undefined &&
      (!Number.isSafeInteger(report.parts_checked) || report.parts_checked < 0))
  )
    return bad('contract_mismatch')
  if (exitCode !== (report.valid ? 0 : 1)) return bad('exit_mismatch')
  return Object.freeze({
    evidence: 'helper_json_report',
    status: report.valid ? 'structurally_valid' : 'structurally_invalid',
    errors: report.errors.length,
    warnings: report.warnings.length,
    ...(report.parts_checked !== undefined ? { partsChecked: report.parts_checked } : {})
  })
}
