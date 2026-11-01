import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: true, getAppPath: () => '', getPath: () => '' } }))

import { shellScript } from './commandLineTool'

const shell = spawnSync('sh', ['-c', 'exit 0']).status === 0

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "sidekick it's here "))
  mkdirSync(join(userData, 'control'))
})

afterEach(() => rmSync(userData, { recursive: true, force: true }))

function runScript(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const script = join(userData, 'sidekick')
  writeFileSync(script, shellScript(userData), { mode: 0o755 })
  const result = spawnSync('sh', [script, ...args], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('the installed shell script', () => {
  it('quotes the profile path so a quote in it cannot break out', () => {
    expect(shellScript(userData)).toContain(`it'\\''s here`)
  })

  it.skipIf(!shell)('reports not running, as JSON when asked, without the app', () => {
    const plain = runScript(['doctor'])
    expect(plain.status).toBe(3)
    const json = runScript(['doctor', '--json'])
    expect(json.status).toBe(3)
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, error: { code: 'not-running' } })
  })

  it.skipIf(!shell)('runs the recorded runtime as Node with the arguments intact', () => {
    const probe = join(userData, 'probe.cjs')
    writeFileSync(
      probe,
      'process.stdout.write(JSON.stringify({ node: process.env.ELECTRON_RUN_AS_NODE, args: process.argv.slice(2) }))'
    )
    writeFileSync(join(userData, 'control', 'cli-runtime'), `${process.execPath}\n${probe}\n\n`, {
      mode: 0o600
    })
    const result = runScript(['config', 'set', 'manualLocation', 'San José; $(whoami)'])
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      node: '1',
      args: ['config', 'set', 'manualLocation', 'San José; $(whoami)']
    })
  })
})
