import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { delimiter, join } from 'path'
import { tmpdir } from 'os'
import type { ToolExecutionResult } from '../../shared/agentRuntime'
import { applyDatabaseSchema } from '../bootstrap/database'
import { AgentToolRuntime, safeToolArguments } from './agentToolRuntime'
import { CommandService } from './commandService'
import { CredentialUses } from './credentialUses'
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
      expect(read.modelContent).toBe(`Task ${taskId}: running\n<output>\nready\n</output>`)

      const answered = (await later.router.execute(
        'send_command_input',
        { taskId, input: 'hello', accessLevel: 'auto' },
        contextFor('run-2', 'chat')
      )) as ToolExecutionResult
      expect(answered.modelContent).toContain('echo hello')

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

  it('puts a stored credential in a command variable only after checking it again', async () => {
    const workspace = await temporaryRoot('sidekick-tool-runtime-secret-')
    const data = await temporaryRoot('sidekick-tool-runtime-secret-data-')
    const db = new Database(':memory:')
    applyDatabaseSchema(db)
    const commands = new CommandService(db, join(data, 'commands'))
    const execute = vi.spyOn(commands, 'execute')
    const runtime = new AgentToolRuntime(
      db,
      new WorkspaceReadService(),
      commands,
      new ToolOutputStore(join(data, 'outputs')),
      new McpClientManager()
    )
    const value = `generated-${Date.now().toString(36)}`
    const entry = {
      id: 'gh',
      alias: 'gh-token',
      kind: 'secret' as const,
      description: '',
      createdAt: 1,
      updatedAt: 1,
      needsValue: false
    }
    runtime.setCredentials({
      list: () => [entry],
      openEditor: () => true,
      uses: new CredentialUses({
        list: () => [entry],
        resolve: () => ({ summary: entry, values: { secret: value } }),
        record: vi.fn(),
        setTransientSecrets: vi.fn()
      })
    })
    const session = await runtime.createSession({
      runId: 'run-secret',
      surface: 'conversation',
      workspaceRoot: workspace,
      webSearchEnabled: false,
      capabilities: ['command.execute', 'credentials']
    })
    const context = {
      runId: 'run-secret',
      conversationId: 'chat',
      workspaceRoot: workspace,
      signal: new AbortController().signal
    }
    let calls = 0
    const shell = (command: string, secrets: Record<string, unknown>) => {
      const args = { title: 'Use token', command, secrets, accessLevel: 'auto' }
      const toolCallId = `call-${++calls}`
      // What the kernel does once it approves the call.
      session.router.credentialApproved?.('shell', args, {
        conversationId: 'chat',
        runId: 'run-secret',
        toolCallId
      })
      return session.router.execute('shell', args, {
        ...context,
        toolCallId
      }) as Promise<ToolExecutionResult>
    }
    try {
      const reserved = await shell('node -v', { PATH: 'gh-token' })
      expect(reserved.status).toBe('error')
      expect(reserved.error?.message).toContain('changes how commands run')

      const allowed = await shell('node --version', { GH_TOKEN: 'gh-token' })
      expect(allowed.status).toBe('success')
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ secretEnvironment: { GH_TOKEN: value } })
      )
      expect(JSON.stringify(allowed)).not.toContain(value)

      // A program file in the project, found first on PATH, never receives the value.
      const planted = join(workspace, 'bin')
      await mkdir(planted)
      await writeFile(
        join(planted, process.platform === 'win32' ? 'node.cmd' : 'node'),
        'echo planted\n'
      )
      const savedPath = process.env.PATH
      process.env.PATH = `${planted}${delimiter}${savedPath ?? ''}`
      try {
        execute.mockClear()
        const hijacked = await shell('node --version', { GH_TOKEN: 'gh-token' })
        expect(hijacked.status).toBe('denied')
        expect(hijacked.error?.message).toContain('a file in this project')
        expect(execute).not.toHaveBeenCalled()
      } finally {
        process.env.PATH = savedPath
      }
      expect(
        safeToolArguments('shell', { command: 'gh api /user', secrets: { GH_TOKEN: 'gh-token' } })
      ).toMatchObject({ secrets: { GH_TOKEN: 'gh-token' } })
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
      return {
        elapsed: Date.now() - startedAt,
        ...(result.data as { output?: string } & Record<string, unknown>),
        text: result.modelContent
      }
    }
    try {
      const build = await background(
        "setTimeout(() => { console.log('error: cannot find symbol'); process.exit(1) }, 800)"
      )
      const ended = await wait({ taskIds: [build], seconds: 120 })
      expect(ended).toMatchObject({ woke: 'task_ended', taskId: build, exitCode: 1 })
      expect(ended.output).toContain('cannot find symbol')
      // The model reads the output as lines, not as an escaped JSON string.
      expect(ended.text).toMatch(/^Woke: task ended after [\d.]+ s \(asked for 120 s\)\n/)
      expect(ended.text).toContain('<output>\nerror: cannot find symbol')
      expect(ended.elapsed).toBeLessThan(15_000)
      // It was seen ending, so it is not reported again before the next step.
      expect(commands.takeNotices('chat')).toEqual([])

      const server = await background(
        "setTimeout(() => console.log('ready on http://localhost:5173'), 800); setInterval(() => {}, 1000)"
      )
      const ready = await wait({ taskIds: [server], pattern: 'ready on', seconds: 120 })
      expect(ready).toMatchObject({ woke: 'pattern_matched', taskId: server, state: 'running' })
      expect(ready.output).toContain('ready on http://localhost:5173')

      // Printed while the model was writing its call: the wait slept out all its seconds.
      const early = await background(
        "console.log('listening on 4317'); setInterval(() => {}, 1000)"
      )
      await vi.waitFor(
        async () => expect((await commands.terminals.lines(early))?.join('\n')).toContain('4317'),
        { timeout: 10_000 }
      )
      const already = await wait({ taskIds: [early], pattern: 'listening', seconds: 120 })
      expect(already).toMatchObject({ woke: 'pattern_matched', taskId: early })
      expect(already.elapsed).toBeLessThan(5_000)
      commands.cancelBackground(early, { conversationId: 'chat' })
      await vi.waitFor(() => expect(commands.terminals.get(early)?.state).toBe('stopped'), {
        timeout: 10_000
      })
      commands.takeNotices('chat')

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

  it('reads a binary file as a description, so it can be deleted without the shell', async () => {
    // read refused binary files, delete_file needs a read receipt, so the agent deleted stray
    // screenshots with Remove-Item, outside the mutation service and its history.
    const workspace = await temporaryRoot('sidekick-tool-runtime-binary-')
    const data = await temporaryRoot('sidekick-tool-runtime-binary-data-')
    await writeFile(
      join(workspace, 'shot.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 1, 2])
    )
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
        runId: 'run-binary',
        surface: 'conversation',
        workspaceRoot: workspace,
        webSearchEnabled: false,
        capabilities: ['workspace.read', 'workspace.write'],
        editingDialect: 'structured-edit'
      })
      const context = {
        runId: 'run-binary',
        workspaceRoot: workspace,
        signal: new AbortController().signal
      }
      const read = (await session.router.execute(
        'read',
        { path: 'shot.png' },
        context
      )) as ToolExecutionResult
      expect(read.status).toBe('success')
      expect(read.modelContent).toContain('binary, 10 bytes')
      expect(read.modelContent).toContain('view_image')

      const deleted = (await session.router.execute(
        'delete_file',
        { file_path: 'shot.png', accessLevel: 'auto' },
        context
      )) as ToolExecutionResult
      expect(deleted.status).toBe('success')
      await expect(readFile(join(workspace, 'shot.png'))).rejects.toThrow()
    } finally {
      await runtime.close()
      db.close()
    }
  })

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
    const pastEnd = (await session.router.execute(
      'read',
      { path: 'status.txt', start_line: 50 },
      context
    )) as ToolExecutionResult
    expect(pastEnd.modelContent).toContain('start_line 50 is past the end; the file has 1 lines')
    // A hunk the current file does not contain is input to correct, not a reason to re-read.
    expect(await edit('imagined', 'after')).toMatchObject({
      status: 'error',
      error: { code: 'invalid_arguments', recoveryAction: 'correct_input' }
    })
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

  it('lets the next reply in a chat edit what the last one saw, unless the file changed', async () => {
    // Kept per reply, "now rename it" was refused for a file the agent had written one reply ago.
    const workspace = await temporaryRoot('sidekick-tool-runtime-receipts-')
    const data = await temporaryRoot('sidekick-tool-runtime-receipts-data-')
    await writeFile(join(workspace, 'status.txt'), 'one\n', 'utf8')
    const db = new Database(':memory:')
    applyDatabaseSchema(db)
    const runtime = new AgentToolRuntime(
      db,
      new WorkspaceReadService(),
      new CommandService(db, join(data, 'commands')),
      new ToolOutputStore(join(data, 'outputs')),
      new McpClientManager()
    )
    const reply = async (runId: string, conversationId: string) => {
      const session = await runtime.createSession({
        runId,
        conversationId,
        surface: 'conversation',
        workspaceRoot: workspace,
        webSearchEnabled: false,
        capabilities: ['workspace.read', 'workspace.write']
      })
      const context = { runId, workspaceRoot: workspace, signal: new AbortController().signal }
      return {
        read: () => session.router.execute('read', { path: 'status.txt' }, context),
        edit: (from: string, to: string) =>
          session.router.execute(
            'apply_patch',
            {
              patch: `*** Begin Patch\n*** Update File: status.txt\n@@\n-${from}\n+${to}\n*** End Patch`,
              accessLevel: 'auto'
            },
            context
          ) as Promise<ToolExecutionResult>
      }
    }
    try {
      const first = await reply('run-1', 'chat')
      await first.read()
      expect(await first.edit('one', 'two')).toMatchObject({ status: 'success' })

      expect(await (await reply('run-2', 'chat')).edit('two', 'three')).toMatchObject({
        status: 'success'
      })
      expect(await (await reply('run-3', 'another-chat')).edit('three', 'four')).toMatchObject({
        error: { code: 'stale_read', message: expect.stringContaining('Read receipt required') }
      })

      await writeFile(join(workspace, 'status.txt'), 'edited by the user\n', 'utf8')
      expect(await (await reply('run-4', 'chat')).edit('edited by the user', 'five')).toMatchObject(
        { error: { code: 'stale_read' } }
      )
    } finally {
      await runtime.close()
      db.close()
    }
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
    expect(result.modelContent.startsWith('Exit code: 7\n')).toBe(true)
    expect(result.modelContent).toContain('<stderr>\n{"coordinates":[[0,0]')
    expect(result.modelContent).toContain("The command's own output was complete.")
    expect(result.modelContent.length).toBeLessThan(denseError.length)
    expect(result.output?.originalEstimatedTokens).toBeGreaterThan(10_000)
    expect(result.output?.returnedEstimatedTokens).toBeLessThanOrEqual(8_192)
  })

  it.skipIf(process.platform !== 'win32')(
    'tells the model why a nested powershell -Command broke its quotes',
    async () => {
      const workspace = await temporaryRoot('sidekick-nested-powershell-workspace-')
      const data = await temporaryRoot('sidekick-nested-powershell-data-')
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
        runId: 'nested-powershell-run',
        surface: 'conversation',
        workspaceRoot: workspace,
        webSearchEnabled: false
      })
      // The outer shell expands `$_` inside the double quotes, so the inner script is broken.
      const result = (await session.router.execute(
        'shell',
        {
          title: 'Nested PowerShell',
          command: `powershell -NoProfile -Command "1..3 | Where-Object { $_ -gt 1 } | ForEach-Object { $_.Missing() }"`,
          accessLevel: 'auto'
        },
        {
          runId: 'nested-powershell-run',
          workspaceRoot: workspace,
          signal: new AbortController().signal
        }
      )) as ToolExecutionResult

      expect(result.status).toBe('error')
      expect(result.modelContent).toContain('<sidekick_command_hint')
      expect(result.modelContent).toContain('Run the PowerShell directly')
    }
  )
})
