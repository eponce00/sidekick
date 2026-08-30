import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { applyDatabaseSchema } from '../bootstrap/database'
import {
  classifyVerificationCommand,
  WorkspaceVerificationService
} from './workspaceVerificationService'

describe('WorkspaceVerificationService', () => {
  let db: Database.Database
  let root: string
  let service: WorkspaceVerificationService

  beforeEach(async () => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    root = await mkdtemp(join(tmpdir(), 'sidekick-verification-'))
    service = new WorkspaceVerificationService(db)
  })

  afterEach(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  })

  it('ties evidence to a workspace revision and detects external staleness', async () => {
    await writeFile(join(root, 'app.ts'), 'export const answer = 1\n')
    const baseline = service.beginSession(root)
    expect(
      service.recordChanges('run-1', root, 'workspace_tool', [{ path: 'app.ts', kind: 'update' }])
    ).toBe(1)
    expect(service.summary('run-1', root, baseline).status).toBe('unverified')

    service.recordCommand(
      'run-1',
      root,
      'npm test',
      undefined,
      { success: true, exitCode: 0, stdout: 'Tests 18 passed', stderr: '' },
      Date.now()
    )
    expect(service.summary('run-1', root, baseline)).toMatchObject({
      status: 'passed',
      currentRevision: 1,
      changedPaths: ['app.ts']
    })
    expect(service.evidence('run-1', root).at(-1)?.summary).toBe('Tests passed (18 passed).')

    await writeFile(join(root, 'app.ts'), 'export const answer = 2\n')
    expect(service.summary('run-1', root, baseline).status).toBe('stale')
  })

  it('nudges completion once and then permits an honest unverified finish', async () => {
    await writeFile(join(root, 'main.py'), 'print("hello")\n')
    service.recordChanges('run-2', root, 'workspace_tool', [{ path: 'main.py', kind: 'create' }])
    const controller = service.createTerminalController('run-2', root, 0)!

    const first = await controller.afterTerminalTurn()
    const second = await controller.afterTerminalTurn()

    expect(first.continue).toBe(true)
    expect(first.prompt).toContain('sidekick_verification_guard')
    expect(second).toMatchObject({ continue: false, summary: { status: 'unverified' } })
  })

  it.each([
    ['cargo test', 'test'],
    ['go vet ./...', 'check'],
    ['python -m pytest', 'test'],
    ['bundle exec rubocop', 'lint'],
    ['dotnet build', 'build'],
    ['pnpm typecheck', 'typecheck'],
    ['./gradlew test', 'test'],
    ['swift test', 'test']
  ])('classifies %s as %s', (command, kind) => {
    expect(classifyVerificationCommand(command).kind).toBe(kind)
  })

  it('treats unknown shell work conservatively but keeps reads revision-neutral', () => {
    expect(classifyVerificationCommand('rg -n "hello" src').mutatesWorkspace).toBe(false)
    expect(classifyVerificationCommand('node scripts/generate.mjs').mutatesWorkspace).toBe(true)
    expect(classifyVerificationCommand('sed -i.bak s/old/new/ app.ts').mutatesWorkspace).toBe(true)
  })

  it('advances revisions only when a command actually changes workspace files', async () => {
    await writeFile(join(root, 'app.ts'), 'before\n')
    const readOnlySnapshot = service.captureCommandWorkspace(root, 'Invoke-WebRequest https://example.com')
    service.recordCommand(
      'run-observed',
      root,
      'Invoke-WebRequest https://example.com',
      undefined,
      { success: true, exitCode: 0, stdout: '200', stderr: '' },
      Date.now(),
      readOnlySnapshot
    )
    expect(service.currentRevision(root)).toBe(0)

    const mutationSnapshot = service.captureCommandWorkspace(root, 'node scripts/generate.mjs')
    await writeFile(join(root, 'app.ts'), 'after\n')
    service.recordCommand(
      'run-observed',
      root,
      'node scripts/generate.mjs',
      undefined,
      { success: true, exitCode: 0, stdout: '', stderr: '' },
      Date.now(),
      mutationSnapshot
    )
    expect(service.currentRevision(root)).toBe(1)
    expect(service.changedPaths('run-observed', root, 0)).toEqual(['app.ts'])
  })

  it('labels shell launch failures separately and ignores CLIXML noise', () => {
    service.recordChanges('run-errors', root, 'workspace_tool', [
      { path: 'app.ts', kind: 'update' }
    ])
    service.recordCommand(
      'run-errors',
      root,
      'npm run build',
      undefined,
      {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: '',
        error: 'spawn powershell.exe ENOENT'
      },
      Date.now()
    )
    service.recordCommand(
      'run-errors',
      root,
      'npm run build',
      undefined,
      {
        success: false,
        exitCode: 1,
        stdout: 'npm error code ENOENT',
        stderr: '#< CLIXML\r\n<Objs Version="1.1.0.1">'
      },
      Date.now()
    )

    expect(service.evidence('run-errors', root).map((item) => item.summary)).toEqual([
      'Command could not start: spawn powershell.exe ENOENT.',
      'Build failed: npm error code ENOENT.'
    ])
  })
})
