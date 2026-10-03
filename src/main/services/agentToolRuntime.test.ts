import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ToolExecutionResult } from '../../shared/agentRuntime'
import { applyDatabaseSchema } from '../bootstrap/database'
import {
  AgentToolRuntime,
  collaborationCommandScopeError,
  safeToolArguments
} from './agentToolRuntime'
import { CommandService } from './commandService'
import { McpClientManager } from './mcpClientManager'
import { ToolOutputStore } from './toolOutputStore'
import { WorkspaceReadService } from './workspaceReadService'
import { LanguageIntelligenceService } from './languageIntelligence/languageIntelligenceService'
import { WorkspaceVerificationService } from './workspaceVerificationService'

const roots: string[] = []

describe('safe tool arguments', () => {
  it('says how much of a long value the preview left out', () => {
    // A bare ellipsis read as part of the value when the preview came back
    // through history, and the model copied it into a new call.
    const patch = safeToolArguments('apply_patch', {
      patch: '*** Begin Patch\n*** End Patch',
      accessLevel: 'auto'
    })
    // Replayed history must show the real argument name, never a byte-count stand-in.
    expect(patch).toEqual({ patch: '*** Begin Patch\n*** End Patch' })
    const long = safeToolArguments('write', { file_path: 'a.txt', content: 'x'.repeat(20_000) })
    expect(String(long.content)).toContain('4,000 more characters were not kept')
    const safe = safeToolArguments('create_artifact', { code: 'a'.repeat(2_500) })
    expect(safe.code).toBe(`${'a'.repeat(2_000)}… [500 more characters not kept]`)
  })

  it('never persists text typed into a browser field', () => {
    expect(
      safeToolArguments('browser_type', {
        ref: 'ax-2-9',
        value: 'correct horse battery staple',
        clear: true,
        submit: false
      })
    ).toEqual({
      ref: 'ax-2-9',
      clear: true,
      submit: false,
      value_redacted: true,
      value_bytes: 28
    })
  })

  it('redacts every value kind in a batched browser form', () => {
    const safe = safeToolArguments('browser_fill_form', {
      fields: [
        { kind: 'textbox', ref: 'ax-2-9', value: 'private text' },
        { kind: 'select', selector: '#country', values: ['Private option'] },
        { kind: 'checkbox', text: 'Sensitive preference', checked: true },
        { kind: 'radio', ref: 'ax-2-12', checked: true }
      ]
    })

    expect(safe).toEqual({
      fields: [
        {
          kind: 'textbox',
          ref: 'ax-2-9',
          selector: undefined,
          text: undefined,
          value_redacted: true,
          value_bytes: 12
        },
        {
          kind: 'select',
          ref: undefined,
          selector: '#country',
          text: undefined,
          values_redacted: true,
          value_count: 1,
          values_bytes: 14
        },
        {
          kind: 'checkbox',
          ref: undefined,
          selector: undefined,
          text: 'Sensitive preference',
          checked_redacted: true
        },
        {
          kind: 'radio',
          ref: 'ax-2-12',
          selector: undefined,
          text: undefined,
          checked_redacted: true
        }
      ]
    })
    expect(JSON.stringify(safe)).not.toContain('private text')
    expect(JSON.stringify(safe)).not.toContain('Private option')
  })
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('AgentToolRuntime file receipts', () => {
  it.each([false, true])(
    'records only complete diagnostics for the inspected file (truncated=%s)',
    async (truncated) => {
      const workspace = await temporaryRoot('sidekick-diagnostic-scope-')
      const data = await temporaryRoot('sidekick-diagnostic-data-')
      await writeFile(join(workspace, 'package.json'), '{"scripts":{"test":"vitest"}}')
      await writeFile(join(workspace, 'a.ts'), 'before\n')
      await writeFile(join(workspace, 'b.ts'), 'before\n')
      vi.spyOn(LanguageIntelligenceService.prototype, 'diagnosticsAfterChanges').mockResolvedValue({
        diagnostics: [],
        attemptedFiles: [],
        failedFiles: [],
        complete: false
      })
      vi.spyOn(LanguageIntelligenceService.prototype, 'execute').mockResolvedValue({
        operation: 'diagnostics',
        serverId: 'fixture',
        filePath: 'a.ts',
        result: [],
        resultCount: 0,
        truncated
      })
      const db = new Database(':memory:')
      applyDatabaseSchema(db)
      const runtime = new AgentToolRuntime(
        db,
        new WorkspaceReadService(),
        new CommandService(db, join(data, 'commands')),
        new ToolOutputStore(join(data, 'outputs')),
        new McpClientManager()
      )
      const session = await runtime.createSession({
        runId: 'scope',
        surface: 'conversation',
        workspaceRoot: workspace,
        webSearchEnabled: false,
        capabilities: ['workspace.read', 'workspace.write', 'command.execute']
      })
      const context = {
        runId: 'scope',
        workspaceRoot: workspace,
        signal: new AbortController().signal
      }
      try {
        for (const path of ['a.ts', 'b.ts']) await session.router.execute('read', { path }, context)
        const patch =
          '*** Begin Patch\n*** Update File: a.ts\n@@\n-before\n+after\n*** Update File: b.ts\n@@\n-before\n+after\n*** End Patch'
        expect(await session.router.execute('apply_patch', { patch }, context)).toMatchObject({
          status: 'success'
        })
        await session.router.execute(
          'code_intelligence',
          { operation: 'diagnostics', file_path: 'a.ts' },
          context
        )
        const verification = new WorkspaceVerificationService(db)
        expect(verification.evidence('scope', workspace).map((item) => item.changedPaths)).toEqual(
          truncated ? [] : [['a.ts']]
        )
        expect(verification.summary('scope', workspace, 0).status).toBe('unverified')
      } finally {
        await runtime.close()
        db.close()
      }
    }
  )
  it('treats ./, absolute and plain spellings of a path as one read receipt', async () => {
    const workspace = await temporaryRoot('sidekick-tool-runtime-workspace-')
    const data = await temporaryRoot('sidekick-tool-runtime-data-')
    await mkdir(join(workspace, 'docs'))
    await writeFile(join(workspace, 'docs', 'note.md'), 'before\n', 'utf8')
    const db = new Database(':memory:')
    applyDatabaseSchema(db)
    const runtime = new AgentToolRuntime(
      db,
      new WorkspaceReadService(),
      new CommandService(db, join(data, 'commands')),
      new ToolOutputStore(join(data, 'outputs')),
      new McpClientManager()
    )
    try {
      const session = await runtime.createSession({
        runId: 'run-paths',
        surface: 'conversation',
        workspaceRoot: workspace,
        webSearchEnabled: false,
        capabilities: ['workspace.read', 'workspace.write'],
        editingDialect: 'structured-edit'
      })
      const context = {
        runId: 'run-paths',
        workspaceRoot: workspace,
        signal: new AbortController().signal
      }
      await session.router.execute('read', { path: './docs/note.md' }, context)
      const result = (await session.router.execute(
        'edit',
        {
          file_path: join(workspace, 'docs', 'note.md'),
          old_string: 'before',
          new_string: 'after',
          replace_all: false
        },
        context
      )) as ToolExecutionResult
      expect(result.status).toBe('success')
      expect(await readFile(join(workspace, 'docs', 'note.md'), 'utf8')).toBe('after\n')
    } finally {
      await runtime.close()
      db.close()
    }
  })
  it('lets a later reply read and answer a command its conversation started', async () => {
    const workspace = await temporaryRoot('sidekick-tool-runtime-terminal-')
    const data = await temporaryRoot('sidekick-tool-runtime-terminal-data-')
    const db = new Database(':memory:')
    applyDatabaseSchema(db)
    const commands = new CommandService(db, join(data, 'commands'))
    const runtime = new AgentToolRuntime(
      db,
      new WorkspaceReadService(),
      commands,
      new ToolOutputStore(join(data, 'outputs')),
      new McpClientManager()
    )
    const sessionFor = (runId: string) =>
      runtime.createSession({
        runId,
        surface: 'conversation',
        workspaceRoot: workspace,
        webSearchEnabled: false,
        capabilities: ['command.execute', 'command.background']
      })
    const contextFor = (runId: string, conversationId: string) => ({
      runId,
      conversationId,
      workspaceRoot: workspace,
      signal: new AbortController().signal
    })
    try {
      const first = await sessionFor('run-1')
      const started = (await first.router.execute(
        'shell',
        {
          title: 'Echo lines',
          command: `node -e "console.log('ready'); process.stdin.on('data', (d) => console.log('echo ' + d.toString().trim()))"`,
          background: true,
          accessLevel: 'auto'
        },
        contextFor('run-1', 'chat')
      )) as ToolExecutionResult
      const taskId = (started.data as { id: string }).id
      expect(started.modelContent).toContain('read_command_output')
      await vi.waitFor(
        () => expect(commands.terminals.get(taskId)?.outputLength).toBeGreaterThan(0),
        {
          timeout: 10_000
        }
      )

      const later = await sessionFor('run-2')
      const read = (await later.router.execute(
        'read_command_output',
        { taskId },
        contextFor('run-2', 'chat')
      )) as ToolExecutionResult
      expect(read.status).toBe('success')
      expect(JSON.parse(read.modelContent!)).toMatchObject({ state: 'running', output: 'ready' })

      const answered = (await later.router.execute(
        'send_command_input',
        { taskId, input: 'hello', accessLevel: 'auto' },
        contextFor('run-2', 'chat')
      )) as ToolExecutionResult
      expect(JSON.parse(answered.modelContent!).output).toContain('echo hello')

      const elsewhere = (await later.router.execute(
        'read_command_output',
        { taskId },
        contextFor('run-3', 'another-chat')
      )) as ToolExecutionResult
      expect(elsewhere).toMatchObject({ status: 'error', error: { code: 'not_found' } })
      await later.router.execute(
        'cancel_background_task',
        { taskId, accessLevel: 'auto' },
        contextFor('run-2', 'chat')
      )
      // The project folder is free once the stopped command has ended.
      await vi.waitFor(() => expect(commands.terminals.get(taskId)?.state).toBe('stopped'), {
        timeout: 10_000
      })
    } finally {
      commands.cancelAll()
      await runtime.close()
      db.close()
    }
  }, 30_000)

  it('waits until a command ends, prints what was asked for, or the user writes', async () => {
    // A fixed 200-second wait slept through a build that had failed after 4.8 seconds.
    const workspace = await temporaryRoot('sidekick-tool-runtime-wait-')
    const data = await temporaryRoot('sidekick-tool-runtime-wait-data-')
    const db = new Database(':memory:')
    applyDatabaseSchema(db)
    const commands = new CommandService(db, join(data, 'commands'))
    const runtime = new AgentToolRuntime(
      db,
      new WorkspaceReadService(),
      commands,
      new ToolOutputStore(join(data, 'outputs')),
      new McpClientManager()
    )
    const session = await runtime.createSession({
      runId: 'run-wait',
      surface: 'conversation',
      workspaceRoot: workspace,
      webSearchEnabled: false,
      capabilities: ['command.execute', 'command.background', 'wait']
    })
    const context = {
      runId: 'run-wait',
      conversationId: 'chat',
      workspaceRoot: workspace,
      signal: new AbortController().signal
    }
    const background = async (script: string): Promise<string> => {
      const started = (await session.router.execute(
        'shell',
        { title: 'Work', command: `node -e "${script}"`, background: true, accessLevel: 'auto' },
        context
      )) as ToolExecutionResult
      return (started.data as { id: string }).id
    }
    const wait = async (args: Record<string, unknown>) => {
      const startedAt = Date.now()
      const result = (await session.router.execute('wait', args, context)) as ToolExecutionResult
      return { elapsed: Date.now() - startedAt, ...JSON.parse(result.modelContent!) }
    }
    try {
      const build = await background(
        "setTimeout(() => { console.log('error: cannot find symbol'); process.exit(1) }, 800)"
      )
      const ended = await wait({ taskIds: [build], seconds: 120 })
      expect(ended).toMatchObject({ woke: 'task_ended', taskId: build, exitCode: 1 })
      expect(ended.output).toContain('cannot find symbol')
      expect(ended.elapsed).toBeLessThan(15_000)
      // It was seen ending, so it is not reported again before the next step.
      expect(commands.takeNotices('chat')).toEqual([])

      const server = await background(
        "setTimeout(() => console.log('ready on http://localhost:5173'), 800); setInterval(() => {}, 1000)"
      )
      const ready = await wait({ taskIds: [server], pattern: 'ready on', seconds: 120 })
      expect(ready).toMatchObject({ woke: 'pattern_matched', taskId: server, state: 'running' })
      expect(ready.output).toContain('ready on http://localhost:5173')

      setTimeout(() => runtime.notifyUserMessage('run-wait'), 300)
      const interrupted = await wait({ seconds: 30 })
      expect(interrupted).toMatchObject({ woke: 'user_message' })
      expect(interrupted.elapsed).toBeLessThan(5_000)

      commands.cancelBackground(server, { conversationId: 'chat' })
      await vi.waitFor(() => expect(commands.terminals.get(server)?.state).toBe('stopped'), {
        timeout: 10_000
      })
    } finally {
      commands.cancelAll()
      await runtime.close()
      db.close()
    }
  }, 60_000)

  it('binds existing-file mutations to reads performed by the same run', async () => {
    const workspace = await temporaryRoot('sidekick-tool-runtime-workspace-')
    const data = await temporaryRoot('sidekick-tool-runtime-data-')
    await writeFile(join(workspace, 'package.json'), '{"scripts":{"test":"vitest"}}')
    await writeFile(join(workspace, 'status.txt'), 'before\n', 'utf8')
    const db = new Database(':memory:')
    applyDatabaseSchema(db)
    const runtime = new AgentToolRuntime(
      db,
      new WorkspaceReadService(),
      new CommandService(db, join(data, 'commands')),
      new ToolOutputStore(join(data, 'outputs')),
      new McpClientManager()
    )
    const session = await runtime.createSession({
      runId: 'run-1',
      surface: 'conversation',
      workspaceRoot: workspace,
      webSearchEnabled: false,
      capabilities: ['workspace.read', 'workspace.write', 'command.execute']
    })
    const context = {
      runId: 'run-1',
      workspaceRoot: workspace,
      signal: new AbortController().signal
    }
    const edit = (oldString: string, newString: string) =>
      session.router.execute(
        'apply_patch',
        {
          patch: `*** Begin Patch\n*** Update File: status.txt\n@@\n-${oldString}\n+${newString}\n*** End Patch`,
          accessLevel: 'auto'
        },
        context
      ) as Promise<ToolExecutionResult>

    expect(await edit('before', 'after')).toMatchObject({
      status: 'error',
      error: { code: 'stale_read', message: expect.stringContaining('Read receipt required') }
    })

    await session.router.execute('read', { path: 'status.txt' }, context)
    await writeFile(join(workspace, 'status.txt'), 'external\n', 'utf8')
    expect(await edit('external', 'after')).toMatchObject({
      status: 'error',
      error: { code: 'stale_read', message: expect.stringContaining('Stale read receipt') }
    })

    await session.router.execute('read', { path: 'status.txt' }, context)
    await expect(
      session.router.execute(
        'shell',
        {
          title: 'Inspect without changing files',
          command: process.platform === 'win32' ? 'Write-Output inspected' : 'printf inspected',
          accessLevel: 'auto'
        },
        context
      )
    ).resolves.toMatchObject({ status: 'success' })
    expect(await edit('external', 'after')).toMatchObject({ status: 'success' })
    await session.router.execute(
      'shell',
      {
        title: 'Mutate the inspected file',
        command:
          process.platform === 'win32'
            ? "[IO.File]::WriteAllText((Join-Path $PWD 'status.txt'), 'changed by shell')"
            : "printf 'changed by shell' > status.txt",
        accessLevel: 'auto'
      },
      context
    )
    expect(await edit('changed by shell', 'final')).toMatchObject({
      status: 'error',
      error: { code: 'stale_read' }
    })
    await expect(session.verificationController?.afterTerminalTurn()).resolves.toMatchObject({
      continue: true,
      summary: {
        status: 'unverified',
        currentRevision: 2,
        changedPaths: ['status.txt']
      }
    })

    await expect(
      session.router.execute('read_workspace_file', { file_path: 'status.txt' }, context)
    ).resolves.toMatchObject({
      status: 'error',
      error: { code: 'unknown_tool' }
    })
  })

  it('keeps collaboration shell commands inside their immutable project root', async () => {
    const workspace = await temporaryRoot('sidekick-collaboration-workspace-')
    const data = await temporaryRoot('sidekick-collaboration-data-')
    const db = new Database(':memory:')
    applyDatabaseSchema(db)
    const runtime = new AgentToolRuntime(
      db,
      new WorkspaceReadService(),
      new CommandService(db, join(data, 'commands')),
      new ToolOutputStore(join(data, 'outputs')),
      new McpClientManager()
    )
    const session = await runtime.createSession({
      runId: 'collaboration-run',
      surface: 'collaboration',
      workspaceRoot: workspace,
      webSearchEnabled: false
    })
    const context = {
      runId: 'collaboration-run',
      workspaceRoot: workspace,
      signal: new AbortController().signal
    }

    await expect(
      session.router.execute(
        'shell',
        {
          title: 'Read peer data directly',
          command: 'cat /Users/example/peer-project/private.csv',
          accessLevel: 'auto'
        },
        context
      )
    ).resolves.toMatchObject({ status: 'error', error: { code: 'workspace_scope' } })

    await expect(
      session.router.execute(
        'shell',
        {
          title: 'Leave project root',
          command: 'cd .. && mv project renamed-project',
          accessLevel: 'auto'
        },
        context
      )
    ).resolves.toMatchObject({ status: 'error', error: { code: 'workspace_scope' } })
  })

  it('passes the trusted full-access mode to external image reads in a real tool session', async () => {
    const workspace = await temporaryRoot('sidekick-image-mode-project-')
    const data = await temporaryRoot('sidekick-image-mode-external-')
    const image = join(data, 'pixel.png')
    await writeFile(
      image,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      )
    )
    const db = new Database(':memory:')
    applyDatabaseSchema(db)
    try {
      const runtime = new AgentToolRuntime(
        db,
        new WorkspaceReadService(),
        new CommandService(db, join(data, 'commands')),
        new ToolOutputStore(join(data, 'outputs')),
        new McpClientManager()
      )
      const session = await runtime.createSession({
        runId: 'image-mode',
        surface: 'conversation',
        workspaceRoot: workspace,
        webSearchEnabled: false,
        permissionMode: 'full-access'
      })
      const result = await session.router.execute(
        'view_image',
        { path: image },
        {
          runId: 'image-mode',
          workspaceRoot: workspace,
          signal: new AbortController().signal
        }
      )
      expect(result).toMatchObject({
        status: 'success',
        media: [
          {
            source: {
              type: 'data_url',
              dataUrl:
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
            }
          }
        ]
      })
    } finally {
      db.close()
    }
  })

  it('reports a nonzero foreground command exit as a failed tool call', async () => {
    const workspace = await temporaryRoot('sidekick-command-failure-workspace-')
    const data = await temporaryRoot('sidekick-command-failure-data-')
    const db = new Database(':memory:')
    applyDatabaseSchema(db)
    const runtime = new AgentToolRuntime(
      db,
      new WorkspaceReadService(),
      new CommandService(db, join(data, 'commands')),
      new ToolOutputStore(join(data, 'outputs')),
      new McpClientManager()
    )
    const session = await runtime.createSession({
      runId: 'failed-command-run',
      surface: 'conversation',
      workspaceRoot: workspace,
      webSearchEnabled: false
    })
    const denseError = JSON.stringify({
      coordinates: Array.from({ length: 5_000 }, (_, index) => [index / 100, -index / 100])
    })
    if (process.platform === 'win32') {
      await writeFile(
        join(workspace, 'fail.ps1'),
        `$dense = @'\n${denseError}\n'@\n[Console]::Error.Write($dense)\ncmd.exe /d /c exit 7\n`,
        'utf8'
      )
    } else {
      await writeFile(
        join(workspace, 'fail.cjs'),
        `process.stderr.write(${JSON.stringify(denseError)}); process.exit(7)`,
        'utf8'
      )
    }
    const result = (await session.router.execute(
      'shell',
      {
        title: 'Expected failure',
        command: process.platform === 'win32' ? '& .\\fail.ps1' : 'node fail.cjs',
        accessLevel: 'auto'
      },
      {
        runId: 'failed-command-run',
        workspaceRoot: workspace,
        signal: new AbortController().signal
      }
    )) as ToolExecutionResult

    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'command_failed', recoveryAction: 'change_strategy' },
      data: { success: false, exitCode: 7 },
      output: {
        truncated: true,
        originalEstimatedTokens: expect.any(Number),
        returnedEstimatedTokens: expect.any(Number),
        fullOutputHandle: expect.any(String)
      }
    })
    expect(result.modelContent).toContain('"success":false')
    expect(result.modelContent.length).toBeLessThan(denseError.length)
    expect(result.output?.originalEstimatedTokens).toBeGreaterThan(10_000)
    expect(result.output?.returnedEstimatedTokens).toBeLessThanOrEqual(8_192)
  })
})

describe('collaboration command scope', () => {
  const root = '/Users/developer/Documents/Agent Projects/Webpage'

  it('does not mistake http and https URLs for Windows drive paths', () => {
    expect(collaborationCommandScopeError('curl -s http://localhost:3000 | head -20', root)).toBe(
      null
    )
    expect(collaborationCommandScopeError('curl https://example.com/home/report.json', root)).toBe(
      null
    )
  })

  it('rejects absolute paths outside the collaboration project', () => {
    expect(
      collaborationCommandScopeError('cat /Users/developer/Documents/Data/private.csv', root)
    ).toContain('outside the assigned project root')
    expect(collaborationCommandScopeError('type C:\\Users\\Peer\\private.csv', root)).toContain(
      'outside the assigned project root'
    )
    expect(collaborationCommandScopeError('cat /etc/passwd', root)).toContain(
      'outside the assigned project root'
    )
    expect(collaborationCommandScopeError('cp report.csv /tmp/report.csv', root)).toContain(
      'outside the assigned project root'
    )
  })

  it('rejects common shell aliases for locations outside the project', () => {
    for (const command of [
      'cat ~/.ssh/config',
      'find $HOME -name credentials',
      'ls ${TMPDIR}',
      'type %USERPROFILE%\\.ssh\\config',
      'Get-Content $env:USERPROFILE\\.ssh\\config'
    ]) {
      expect(collaborationCommandScopeError(command, root), command).toContain(
        'outside the assigned project root'
      )
    }
  })

  it('allows explicit absolute paths that remain under the assigned root', () => {
    expect(
      collaborationCommandScopeError(
        'cat /Users/developer/Documents/Agent\\ Projects/Webpage/report.csv',
        root
      )
    ).toBeNull()
  })
})
