import Database from 'better-sqlite3'
import { mkdtemp, mkdir, rm, copyFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { CommandService } from './commandService'
import { applyDatabaseSchema } from '../bootstrap/database'

it.skipIf(process.env.SIDEKICK_ISOLATED_SKILLS_RUN !== '1')(
  'reads a shipped helper copy read-only through the existing pinned container',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-isolated-skills-'))
    const workspace = join(root, 'workspace')
    const assets = join(root, 'fixture app with spaces', 'resources', 'skills')
    await mkdir(workspace)
    await mkdir(join(assets, 'office'), { recursive: true })
    for (const name of ['preflight.py', 'office/validate.py'])
      await copyFile(resolve('resources/skills', name), join(assets, name))
    const original = await readFile(join(assets, 'preflight.py'))
    const db = new Database(':memory:')
    applyDatabaseSchema(db)
    const service = new CommandService(db, join(root, 'commands'), undefined, assets, () => true)
    try {
      const probe = `const fs=require('fs');const r=process.env.SIDEKICK_SKILLS;let denied=false;try{fs.writeFileSync(r+'/.readonly-probe','synthetic')}catch(e){denied=e.code==='EROFS'||e.code==='EACCES'}console.log(JSON.stringify({root:r,readable:fs.readFileSync(r+'/preflight.py','utf8').includes('WORKFLOWS'),readOnly:denied}));if(!denied)process.exitCode=1`
      const result = await service.execute({
        runId: 'isolated-skills',
        title: 'Check read-only helper mapping',
        workspaceRoot: workspace,
        command: `node -e ${JSON.stringify(probe)}`,
        timeoutSecs: 20
      })
      expect('success' in result && result.success).toBe(true)
      if (!('stdout' in result)) throw new Error('Unexpected background result')
      expect(JSON.parse(result.stdout)).toEqual({
        root: '/sidekick-skills',
        readable: true,
        readOnly: true
      })
      expect(await readFile(join(assets, 'preflight.py'))).toEqual(original)
    } finally {
      service.cancelAll()
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  45_000
)
