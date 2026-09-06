import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { AgentRunStore } from './agentRunStore'

it('reconciles a killed writer without replaying its already-completed side effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-crash-'))
  let child: ReturnType<typeof spawn> | undefined
  let db: Database.Database | undefined
  try {
    const script = join(root, 'writer.cjs')
    await build({
      entryPoints: [resolve('src/main/services/fixtures/crashRunWriter.ts')],
      outfile: script,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external'
    })
    child = spawn(process.execPath, [script, join(root, 'state.db'), join(root, 'effect.txt')], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_PATH: resolve('node_modules')
      }
    })
    const closed = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Crash fixture did not reach its checkpoint')),
        10000
      )
      child!.once('message', () => {
        clearTimeout(timeout)
        resolve()
      })
      child!.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child!.once('exit', (code) => {
        clearTimeout(timeout)
        reject(new Error(`Fixture exited early: ${code}`))
      })
    })
    child.kill('SIGKILL')
    await closed
    db = new Database(join(root, 'state.db'))
    const store = new AgentRunStore(db)
    expect(store.recoverInterrupted()).toHaveLength(1)
    const results = store
      .listAllEvents('crash-run')
      .filter((event) => event.type === 'tool.completed')
    expect(results).toHaveLength(1)
    expect(results[0].payload.result).toMatchObject({ error: { recoveryAction: 'refresh_state' } })
    expect(JSON.stringify(results[0])).toContain('OUTCOME UNKNOWN')
    expect(await readFile(join(root, 'effect.txt'), 'utf8')).toBe('effect\n')
    expect(store.recoverInterrupted()).toEqual([])
    expect(
      store.listAllEvents('crash-run').filter((event) => event.type === 'tool.completed')
    ).toEqual(results)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
      child.kill('SIGKILL')
      await stopped
    }
    db?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
