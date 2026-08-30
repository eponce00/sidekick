import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
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

const roots: string[] = []

describe('safe tool arguments', () => {
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
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('AgentToolRuntime file receipts', () => {
  it('binds existing-file mutations to reads performed by the same run', async () => {
    const workspace = await temporaryRoot('sidekick-tool-runtime-workspace-')
    const data = await temporaryRoot('sidekick-tool-runtime-data-')
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
