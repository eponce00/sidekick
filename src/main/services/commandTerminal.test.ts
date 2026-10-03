import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { applyDatabaseSchema } from '../bootstrap/database'
import { CommandService, type OwnedBackgroundTask } from './commandService'
import { looksLikePrompt, TerminalScreen } from './terminalScreen'
import { TerminalSessionStore } from './terminalSessions'
import type { ShellCommandResult } from '../../shared/types'
import type { TerminalSessionEvent } from '../../shared/terminalSessions'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((operation) => operation()))
})

/** A node one-liner that runs the same under PowerShell and bash. */
function node(script: string): string {
  return `node -e "${script}"`
}

const ASK = node(
  "process.stdout.write('Continue? (y/n) '); process.stdin.once('data', (d) => { console.log('got ' + d.toString().trim()); process.exit(0) })"
)
const SLEEP = node("console.log('started'); setTimeout(() => {}, 60000)")

async function setup(terminal: boolean): Promise<{
  root: string
  service: CommandService
  db: Database.Database
  events: TerminalSessionEvent[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-command-terminal-'))
  const db = new Database(':memory:')
  applyDatabaseSchema(db)
  const events: TerminalSessionEvent[] = []
  const service = new CommandService(db, join(root, 'outputs'), undefined, undefined, () => false, {
    terminals: new TerminalSessionStore((event) => events.push(event), 400),
    terminalEnabled: () => terminal
  })
  cleanup.push(() => {
    service.cancelAll()
    db.close()
  })
  // A stopped process on Windows can hold its folder a moment longer.
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }))
  return { root, service, db, events }
}

async function until<T>(read: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting')
}

describe('TerminalScreen', () => {
  it('reads output as a terminal shows it', async () => {
    const screen = new TerminalScreen({ newlineIsLineBreak: false })
    // Windows' console host clears and positions the cursor; a progress bar rewrites its line.
    await screen.write(
      '\u001b[?25l\u001b[2J\u001b[Hhi\u001b]0;title\u0007\r\nDownloading 10%\rDownloading 100%\r\n\u001b[32mdone\u001b[0m\r\n'
    )
    expect(screen.lines()).toEqual(['hi', 'Downloading 100%', 'done'])
    expect(screen.pendingLine()).toBeUndefined()
    await screen.write('Ok to proceed? (y) ')
    expect(screen.pendingLine()).toBe('Ok to proceed? (y)')
    screen.dispose()
  })

  it('tells a question from output that paused mid-line', () => {
    for (const line of ['Ok to proceed? (y)', 'Password:', '>>>', 'Overwrite [Y/n]', 'Press Enter'])
      expect(looksLikePrompt(line)).toBe(true)
    for (const line of ['Compiling', 'Downloading 45%', ''])
      expect(looksLikePrompt(line)).toBe(false)
  })
})

describe('TerminalSessionStore', () => {
  it('gives the agent what is new since its last read, the latest lines, or matches', async () => {
    const store = new TerminalSessionStore()
    store.start({
      id: 'server',
      runId: 'run',
      conversationId: 'chat',
      title: 'Serve',
      command: 'npm run dev',
      cwd: '.',
      background: true,
      pty: false
    })
    store.append('server', 'ready on 5173\nGET / 200\n')
    expect((await store.readForModel('server'))?.text).toBe('ready on 5173\nGET / 200')
    store.append('server', 'GET /app.js 404\nGET /x 200\n')
    expect((await store.readForModel('server'))?.text).toBe('GET /app.js 404\nGET /x 200')
    expect((await store.readForModel('server', { mode: 'tail', maxLines: 1 }))?.text).toBe(
      'GET /x 200'
    )
    expect((await store.readForModel('server', { mode: 'tail', pattern: /404/ }))?.text).toBe(
      'GET /app.js 404'
    )
    await store.finish('server', { state: 'stopped', exitCode: -1 })
    expect(store.get('server')).toMatchObject({ state: 'stopped', tail: expect.any(Array) })
    expect(store.list('chat')).toHaveLength(1)
    expect(store.list('another')).toHaveLength(0)
  })

  it('keeps raw output from an offset for a terminal view to replay', () => {
    const store = new TerminalSessionStore()
    store.start({
      id: 'a',
      runId: 'run',
      title: 't',
      command: 'c',
      cwd: '.',
      background: false,
      pty: true
    })
    store.append('a', 'one ')
    store.append('a', 'two')
    expect(store.read('a', 0)).toEqual({
      id: 'a',
      offset: 0,
      data: 'one two',
      truncatedBefore: false
    })
    expect(store.read('a', 4)?.data).toBe('two')
  })
})

describe.each([false, true])('CommandService in a terminal: %s', (terminal) => {
  it('hands a command waiting at a prompt back as a task, then takes its answer', async () => {
    const { root, service } = await setup(terminal)
    const result = (await service.execute({
      runId: 'run',
      conversationId: 'chat',
      toolCallId: 'call-ask',
      title: 'Ask',
      command: ASK,
      workspaceRoot: root,
      timeoutSecs: 30
    })) as OwnedBackgroundTask
    expect(result.detached).toBe('waiting_for_input')
    expect(result.prompt).toContain('Continue? (y/n)')
    expect(service.terminals.get(result.id)).toMatchObject({
      state: 'waiting_for_input',
      background: true,
      toolCallId: 'call-ask'
    })

    const session = service.terminals.get(result.id)!
    expect(service.write(result.id, session.pty ? 'y\r' : 'y\n')).toBe(true)
    const task = await until(() =>
      service.listBackground({ conversationId: 'chat' }).find((item) => item.status !== 'running')
    )
    expect(task.status).toBe('success')
    expect(task.result?.stdout).toContain('got y')
    // A later reply in the same conversation still sees the command.
    expect(service.listBackground({ conversationId: 'chat', runId: 'next-run' })).toHaveLength(1)
  }, 30_000)

  it('ends a command stopped the moment it starts', async () => {
    // Stopped while the shell was still launching it, the program outlived the shell and held
    // its output open, and the command never reported that it ended.
    const { root, service } = await setup(terminal)
    const run = service.execute({
      runId: 'run',
      conversationId: 'chat',
      title: 'Sleep',
      command: SLEEP,
      workspaceRoot: root,
      timeoutSecs: 60
    })
    const session = await until(() => service.terminals.list('chat')[0])
    expect(service.stopByUser(session.id)).toBe(true)
    expect(await run).toMatchObject({ cancelled: true, stoppedByUser: true })
  }, 20_000)

  it('tells the agent the user stopped a command, and can move one to the background', async () => {
    const { root, service } = await setup(terminal)
    const stopped = service.execute({
      runId: 'run',
      conversationId: 'chat',
      title: 'Sleep',
      command: SLEEP,
      workspaceRoot: root,
      timeoutSecs: 60
    })
    const first = await until(() =>
      service.terminals.list('chat').find((session) => session.outputLength > 0)
    )
    expect(service.stopByUser(first.id)).toBe(true)
    const result = (await stopped) as ShellCommandResult
    expect(result).toMatchObject({ success: false, cancelled: true, stoppedByUser: true })
    expect(service.terminals.get(first.id)?.state).toBe('stopped')

    const moved = service.execute({
      runId: 'run',
      conversationId: 'chat',
      title: 'Sleep again',
      command: SLEEP,
      workspaceRoot: root,
      timeoutSecs: 60
    })
    const second = await until(() =>
      service.terminals
        .list('chat')
        .find((session) => session.id !== first.id && session.outputLength > 0)
    )
    expect(service.moveToBackground(second.id)).toBe(true)
    expect(await moved).toMatchObject({ id: second.id, detached: 'user', status: 'running' })
    expect(service.cancelBackground(second.id, { conversationId: 'chat' })).toBe(true)
  }, 30_000)
})

it('returns what a terminal shows when a command runs in one', async () => {
  const { root, service } = await setup(true)
  const result = (await service.execute({
    runId: 'run',
    title: 'Colour',
    command: node("console.log('\\\\x1b[32mgreen\\\\x1b[0m'); console.log('plain')"),
    workspaceRoot: root
  })) as ShellCommandResult
  expect(result.success).toBe(true)
  expect(result.stdout).toContain('green')
  expect(result.stdout).toContain('plain')
  // Wherever a pseudo-terminal opened, the model reads text, not escape sequences.
  if (result.terminal) expect(result.stdout).not.toContain('\u001b')
}, 30_000)
