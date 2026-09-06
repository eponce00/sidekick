import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { executeDirectOfficeHelper } from './directOfficeHelper'

it.skipIf(!process.env.SIDEKICK_DIRECT_HELPER_PYTHON)(
  'bounds real subprocess JSON reports and retains real exit codes',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-helper-report-'))
    const workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot)
    await mkdir(join(root, 'office'))
    await writeFile(join(workspaceRoot, 'fixture-input'), 'synthetic unchanged input')
    const report = JSON.stringify({
      workflow: 'xlsx',
      status: 'available',
      checks: [{ kind: 'python', name: 'openpyxl', available: true }]
    })
    try {
      const structural = (valid: boolean) =>
        JSON.stringify({
          valid,
          scope: 'opc-ooxml-structural',
          xsd_validation: false,
          ...(valid ? { parts_checked: 5 } : {}),
          errors: valid ? [] : ['PRIVATE_PATH'],
          warnings: []
        })
      for (const [helper, code, body, status] of [
        ['preflight', 0, `print(${JSON.stringify(report)})`, 'available'],
        ['preflight', 7, `print(${JSON.stringify(report)})`, 'unusable_output'],
        ['preflight', 0, `print('PRIVATE' * 20000)`, 'unusable_output'],
        ['validate', 0, `print(${JSON.stringify(structural(true))})`, 'structurally_valid'],
        ['validate', 1, `print(${JSON.stringify(structural(false))})`, 'structurally_invalid']
      ] as const) {
        const source = `import sys\n${body}\nsys.exit(${code})\n`
        await writeFile(
          join(root, helper === 'preflight' ? 'preflight.py' : 'office/validate.py'),
          source
        )
        const result = await executeDirectOfficeHelper(
          {
            assetsRoot: root,
            workspaceRoot,
            interpreter: process.env.SIDEKICK_DIRECT_HELPER_PYTHON!,
            windowsSystemRoot: process.env.SystemRoot,
            expectedDigests: { [helper]: createHash('sha256').update(source).digest('hex') }
          },
          helper === 'preflight'
            ? { helper, workflow: 'xlsx', backend: 'host', timeoutMs: 5000 }
            : { helper, path: 'fixture-input', backend: 'host', timeoutMs: 5000 }
        )
        expect(result).toMatchObject({
          lifecycle: 'finished',
          outcome: 'exited',
          exitCode: code,
          report: { evidence: 'helper_json_report', status }
        })
        expect(JSON.stringify(result)).not.toContain('PRIVATE')
        expect(JSON.stringify(result)).not.toContain(root)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  20000
)
