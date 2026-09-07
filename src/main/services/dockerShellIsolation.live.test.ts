import { expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isolatedShellProcess } from './dockerShellIsolation'
import { promisify } from 'node:util'
import { applyDatabaseSchema } from '../bootstrap/database'
import { CommandService } from './commandService'

it.skipIf(process.env.SIDEKICK_DOCKER_EVAL_RUN !== '1')(
  'container deadline survives a killed host client',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-container-crash-'))
    const id = randomUUID()
    const sandbox = await isolatedShellProcess({
      id,
      workspaceRoot: root,
      cwd: root,
      command: 'echo ready; sleep 60',
      timeoutSecs: 2,
      env: process.env
    })
    const child = spawn(sandbox.file, sandbox.args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Container did not start')), 10000)
        child.stdout!.once('data', () => {
          clearTimeout(timer)
          resolve()
        })
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('exit', () => {
          clearTimeout(timer)
          reject(new Error('Container exited before readiness'))
        })
      })
      child.kill('SIGKILL')
      await stopped
      await vi.waitFor(
        async () => {
          const result = await promisify(execFile)(
            'docker',
            ['ps', '-aq', '--filter', `name=^/sidekick-shell-${id}$`],
            { windowsHide: true }
          )
          expect(result.stdout.trim()).toBe('')
        },
        { timeout: 10000, interval: 200 }
      )
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await stopped
      }
      await sandbox.cleanup()
      await rm(root, { recursive: true, force: true })
    }
  },
  25000
)

it.skipIf(process.env.SIDEKICK_DOCKER_EVAL_RUN !== '1')(
  'enforces shell filesystem/network boundaries and removes timed-out containers',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-container-test-'))
    const db = new Database(':memory:')
    applyDatabaseSchema(db)
    try {
      const commands = new CommandService(db, join(root, 'logs'), undefined, undefined, () => true)
      const result = await commands.execute({
        runId: 'isolation-test',
        title: 'Boundary probe',
        workspaceRoot: root,
        command: `node -e 'const fs=require("fs"); fs.writeFileSync("inside.txt","ok"); if(fs.existsSync("/var/run/docker.sock"))process.exit(8); try{fs.writeFileSync("/outside.txt","bad");process.exit(9)}catch{}; const net=require("net");const s=net.connect({host:"1.1.1.1",port:443});s.on("connect",()=>process.exit(10));s.on("error",()=>console.log("isolated-ok"));s.setTimeout(1500,()=>{s.destroy();console.log("isolated-ok")});'`,
        timeoutSecs: 10
      })
      expect(result).toMatchObject({ success: true })
      expect('stdout' in result && result.stdout).toContain('isolated-ok')
      const timeout = await commands.execute({
        runId: 'isolation-test',
        title: 'Timeout',
        workspaceRoot: root,
        command: 'sleep 60',
        timeoutSecs: 1
      })
      expect(timeout).toMatchObject({ success: false })
      const remaining = await promisify(execFile)(
        'docker',
        ['ps', '-aq', '--filter', 'label=sidekick.role=isolated-shell'],
        { windowsHide: true }
      )
      expect(remaining.stdout.trim()).toBe('')
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  60000
)
