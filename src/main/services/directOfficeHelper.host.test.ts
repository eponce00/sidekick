import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { executeDirectOfficeHelper, type OfficeHelperReceipt } from './directOfficeHelper'

// Explicit opt-in only; no interpreter discovery, installation, or artifact authoring.
it.skipIf(!process.env.SIDEKICK_DIRECT_HELPER_PYTHON)(
  'executes existing host Python read-only Office preflight with private receipts',
  async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sidekick-direct-helper-'))
    const assetsRoot = resolve('resources/skills')
    const digest = createHash('sha256')
      .update(await readFile(join(assetsRoot, 'preflight.py')))
      .digest('hex')
    const receipts: Readonly<OfficeHelperReceipt>[] = []
    try {
      const result = await executeDirectOfficeHelper(
        {
          assetsRoot,
          workspaceRoot,
          interpreter: process.env.SIDEKICK_DIRECT_HELPER_PYTHON!,
          windowsSystemRoot: process.env.SystemRoot,
          expectedDigests: { preflight: digest },
          observe: (receipt) => receipts.push(receipt)
        },
        { helper: 'preflight', workflow: 'office', backend: 'host', timeoutMs: 10_000 }
      )
      expect(result).toMatchObject({
        helper: 'preflight',
        helperDigest: digest,
        lifecycle: 'finished',
        outcome: 'exited',
        exitCode: 0,
        report: { evidence: 'helper_json_report', status: 'available', checks: 2, missing: 0 }
      })
      expect(receipts.map((receipt) => receipt.lifecycle)).toEqual(['started', 'finished'])
      expect(JSON.stringify(receipts)).not.toContain(workspaceRoot)
    } finally {
      // Fails if any unexpected file was created; never recursively removes output.
      await rmdir(workspaceRoot)
    }
  },
  20_000
)
