import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import type { ToolExecutionResult } from '../../shared/agentRuntime'
import type { EditingDialect } from '../../shared/workspaceMutations'
import { applyDatabaseSchema } from '../bootstrap/database'
import { AgentToolRegistry } from './agentToolRegistry'
import { AgentToolRuntime, type AgentToolRuntimeSession } from './agentToolRuntime'
import { CommandService } from './commandService'
import { McpClientManager } from './mcpClientManager'
import { ToolOutputStore } from './toolOutputStore'
import { WorkspaceReadService } from './workspaceReadService'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** A real tool session, called the way the run kernel calls it: through the registry. */
async function session(
  options: { workspace?: boolean; editingDialect?: EditingDialect; instructionScope?: boolean } = {}
): Promise<{
  parent: string
  root?: string
  call: (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>
}> {
  const parent = await temporaryRoot('sidekick-tool-refusals-')
  const root = options.workspace === false ? undefined : join(parent, 'project')
  if (root) {
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'one\ntwo\nthree\n')
  }
  await writeFile(join(parent, 'outside.txt'), 'outside\n')
  const db = new Database(':memory:')
  applyDatabaseSchema(db)
  const runtime = new AgentToolRuntime(
    db,
    new WorkspaceReadService(),
    new CommandService(db, join(parent, 'data', 'commands')),
    new ToolOutputStore(join(parent, 'data', 'outputs')),
    new McpClientManager()
  )
  cleanups.push(async () => {
    await runtime.close()
    db.close()
  })
  const tools: AgentToolRuntimeSession = await runtime.createSession({
    runId: 'refusals',
    surface: 'conversation',
    ...(root ? { workspaceRoot: root } : {}),
    ...(options.instructionScope === false ? {} : { instructionScopeId: `refusals:${parent}` }),
    webSearchEnabled: false,
    editingDialect: options.editingDialect ?? 'structured-edit'
  })
  const registry = new AgentToolRegistry()
  const context = { runId: 'refusals', workspaceRoot: root, signal: new AbortController().signal }
  return {
    parent,
    root,
    call: (name, args) =>
      registry.execute(
        {
          catalog: tools.catalog(),
          call: { id: name, name, arguments: args },
          title: name,
          context
        },
        (prepared, executionContext) =>
          tools.router.execute(name, prepared, executionContext) as Promise<ToolExecutionResult>
      )
  }
}

function expectOutOfScope(result: ToolExecutionResult, label: string): void {
  expect(result.status, label).toBe('error')
  expect(result.error, label).toMatchObject({
    code: 'workspace_scope',
    retryable: false,
    recoveryAction: 'change_strategy'
  })
  expect(result.error?.recovery, label).toContain('not granted to this chat')
}

describe('tool refusals in a real tool session', () => {
  it('refuses reads outside the project as out of scope, however the path is spelled', async () => {
    const { parent, root, call } = await session()
    const paths = [
      '..',
      '../outside.txt',
      'src/../../outside.txt',
      join(parent, 'outside.txt'),
      `${root}-sibling${sep}x.ts`,
      ...(process.platform === 'win32'
        ? ['src\\..\\..\\outside.txt', 'src/..\\../outside.txt', '\\\\server\\share\\outside.txt']
        : ['/etc/passwd', '//server/share/outside.txt'])
    ]
    for (const path of paths) {
      const result = await call('read', { path })
      expectOutOfScope(result, path)
      expect(result.modelContent, path).not.toContain('outside\n')
    }
    // Claude Code's file_path names the same refused path.
    expectOutOfScope(await call('read', { file_path: join(parent, 'outside.txt') }), 'file_path')
  })

  it('reads with argument names from other harnesses', async () => {
    const { call } = await session()
    const result = await call('read', { file_path: 'src/a.ts', offset: 2, limit: 1 })
    expect(result.status).toBe('success')
    expect(result.modelContent).toContain('lines 2-2 of 3')
    expect(result.modelContent).toContain('two')
    expect(result.modelContent).not.toContain('three')
  })

  it.each([true, false])(
    'refuses edits outside the project as out of scope (instruction scope: %s)',
    async (instructionScope) => {
      const { parent, call } = await session({ instructionScope })
      const edit = await call('edit', {
        file_path: join(parent, 'outside.txt'),
        old_string: 'outside',
        new_string: 'changed'
      })
      expectOutOfScope(edit, 'edit')
      const write = await call('write', { file_path: '../outside.txt', content: 'changed\n' })
      expectOutOfScope(write, 'write')
      expect(await readFile(join(parent, 'outside.txt'), 'utf8')).toBe('outside\n')
    }
  )

  it('refuses a patch outside the project as out of scope', async () => {
    const { parent, call } = await session({ editingDialect: 'apply-patch' })
    const result = await call('apply_patch', {
      patch: '*** Begin Patch\n*** Add File: ../escaped.txt\n+escaped\n*** End Patch'
    })
    expectOutOfScope(result, 'apply_patch')
    await expect(readFile(join(parent, 'escaped.txt'), 'utf8')).rejects.toThrow()
  })

  it('refuses a working directory outside the project before running the command', async () => {
    const { parent, call } = await session()
    const marker = join(parent, 'ran.txt')
    const result = await call('shell', {
      command:
        process.platform === 'win32'
          ? `Set-Content -LiteralPath '${marker}' x`
          : `echo x > '${marker}'`,
      cwd: parent
    })
    expectOutOfScope(result, 'shell cwd')
    await expect(readFile(marker, 'utf8')).rejects.toThrow()
  })

  it('says a chat without a project folder cannot run commands', async () => {
    const { call } = await session({ workspace: false })
    const result = await call('shell', { command: 'echo hello' })
    expect(result.error).toMatchObject({
      code: 'workspace_scope',
      message: 'This chat has no project folder, so it cannot use project files or run commands',
      recoveryAction: 'change_strategy'
    })
    expect(result.error?.recovery).toContain('move this chat into a project')
  })

  it('treats a tool_output call without a handle as a wrong argument', async () => {
    const { call } = await session()
    for (const handle of ['', 'call_abc123', 'C:\\Users\\me\\output.txt', '../escape']) {
      const result = await call('tool_output', { handle })
      expect(result.error, handle).toMatchObject({
        code: 'invalid_arguments',
        retryable: true,
        recoveryAction: 'correct_input'
      })
      expect(result.error?.message, handle).toContain('tool_output needs the handle')
    }
  })

  it.skipIf(process.platform !== 'win32')(
    'names the PowerShell equivalent of a Unix flag on a PowerShell alias',
    async () => {
      const { call } = await session()
      // cat is PowerShell's alias for Get-Content, which wins over any cat.exe on PATH.
      const result = await call('shell', { command: 'cat -n src/a.ts' })
      expect(result.error?.code).toBe('command_failed')
      expect(result.modelContent).toContain('<sidekick_command_hint trust="app-policy">')
      expect(result.modelContent).toContain('Instead of `cat`, use `Get-Content <file>`')
      expect(result.error?.recovery).toContain('Windows PowerShell, not Bash')
    },
    30_000
  )
})
