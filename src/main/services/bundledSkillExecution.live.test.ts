import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { CommandService } from './commandService'

// Explicit opt-in: host Python/dependencies are not part of the Node test contract.
it.runIf(process.env.SIDEKICK_SKILL_HELPER_TEST === '1')(
  'executes shipped preflight and disposable helper qualification through CommandService',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-skill-command-'))
    const db = new Database(':memory:')
    applyDatabaseSchema(db)
    const assets = resolve(process.env.SIDEKICK_TEST_SKILL_ASSETS || 'resources/skills')
    const qualification = resolve('scripts/qualify-bundled-skills.py')
    const service = new CommandService(db, join(root, 'logs'), undefined, assets)
    const quote = (value: string): string =>
      process.platform === 'win32'
        ? `'${value.replace(/'/g, "''")}'`
        : `'${value.replace(/'/g, "'\\''")}'`
    try {
      const python = process.platform === 'win32' ? 'python' : 'python3'
      const helper =
        process.platform === 'win32'
          ? '"$env:SIDEKICK_SKILLS\\preflight.py"'
          : '"$SIDEKICK_SKILLS/preflight.py"'
      const probe = await service.execute({
        runId: 'skill-preflight',
        title: 'Discover helper dependencies',
        workspaceRoot: root,
        command: `${python} ${helper} office-xsd`
      })
      expect('stdout' in probe).toBe(true)
      if (!('stdout' in probe)) throw new Error('Unexpected background result')
      const report = JSON.parse(probe.stdout)
      expect(['available', 'missing_dependencies']).toContain(report.status)
      expect(report.checks).toContainEqual(
        expect.objectContaining({ kind: 'bundled-asset', name: 'office/schemas' })
      )
      const result = await service.execute({
        runId: 'skill-qualification',
        title: 'Qualify bundled helpers with disposable fixtures',
        workspaceRoot: root,
        command: `${python} ${quote(qualification)} --assets ${quote(assets)}`,
        timeoutSecs: 60
      })
      expect('success' in result && result.success).toBe(true)
      if ('stderr' in result) {
        // Skips remain visible; a dependency discovery pass is not execution proof.
        console.info(result.stderr)
        expect(result.stderr).toMatch(/Ran \d+ tests/)
      }
    } finally {
      service.cancelAll()
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  70_000
)
