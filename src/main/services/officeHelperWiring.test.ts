import Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { AgentToolRuntime } from './agentToolRuntime'
import { AgentToolRegistry } from './agentToolRegistry'
import { AgentRunKernel, type AgentKernelProviderSampler } from './agentRunKernel'
import { AgentRunStore } from './agentRunStore'
import { CommandService } from './commandService'
import { WorkspaceReadService } from './workspaceReadService'
import { McpClientManager } from './mcpClientManager'
import { ToolOutputStore } from './toolOutputStore'
import { OfficeHelperService, validateOfficeInterpreter } from './officeHelperService'
import { agentRunProfile, getAgentToolDefinitions } from '../../shared/agentToolCatalog'
import { clearWorkspaceInstructionScope } from './workspaceRules'
import type { ProviderSettings } from '../../shared/settings'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn
}))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
  spawn.mockReset()
})
type OfficeSettings = Pick<
  ProviderSettings,
  'officeHelperInterpreter' | 'officeHelperConfigurationId' | 'shellIsolation'
>
async function fixture(initial: OfficeSettings = { officeHelperInterpreter: process.execPath }) {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-office-wiring-'))
  const workspace = join(root, 'workspace'),
    assets = join(root, 'assets')
  await mkdir(workspace)
  await mkdir(join(assets, 'office'), { recursive: true })
  await writeFile(join(assets, 'preflight.py'), 'trusted synthetic preflight')
  await writeFile(join(assets, 'office/validate.py'), 'trusted synthetic validator')
  const db = new Database(':memory:')
  applyDatabaseSchema(db)
  cleanups.push(async () => {
    clearWorkspaceInstructionScope(root)
    db.close()
    const actual = await realpath(root)
    expect(dirname(actual)).toBe(await realpath(tmpdir()))
    expect(basename(actual).startsWith('sidekick-office-wiring-')).toBe(true)
    await rm(actual, { recursive: true, force: true })
  })
  let settings = initial
  const observer = vi.fn()
  const service = new OfficeHelperService(
    () => settings,
    () => assets,
    observer
  )
  const runtime = new AgentToolRuntime(
    db,
    new WorkspaceReadService(),
    new CommandService(db, join(root, 'commands')),
    new ToolOutputStore(join(root, 'outputs')),
    new McpClientManager(),
    undefined,
    undefined,
    undefined,
    service
  )
  const session = await runtime.createSession({
    runId: 'office-run',
    surface: 'conversation',
    workspaceRoot: workspace,
    instructionScopeId: root,
    webSearchEnabled: false,
    capabilities: ['skills', 'command.execute', 'workspace.read']
  })
  const registry = new AgentToolRegistry()
  const invoke = (
    name: string,
    args: Record<string, unknown>,
    signal = new AbortController().signal
  ) =>
    registry.execute(
      {
        catalog: session.catalog(),
        call: { id: 'actual-call', name, arguments: args },
        title: 'Office test',
        context: {
          runId: 'office-run',
          workspaceRoot: workspace,
          toolCallId: 'forged-context',
          signal
        }
      },
      (args, context) => session.router.execute(name, args, context)
    )
  spawn.mockImplementation((_executable, argv: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() })
    queueMicrotask(() => {
      child.emit('spawn')
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify(
            argv.some((arg) => arg.endsWith('validate.py'))
              ? {
                  valid: true,
                  scope: 'opc-ooxml-structural',
                  xsd_validation: false,
                  parts_checked: 5,
                  errors: [],
                  warnings: []
                }
              : {
                  workflow: 'xlsx',
                  status: 'available',
                  checks: [{ kind: 'python', name: 'openpyxl', available: true }]
                }
          )
        )
      )
      child.emit('close', 0)
    })
    return child
  })
  return {
    invoke,
    session,
    observer,
    db,
    workspace,
    service,
    setSettings: (next: OfficeSettings) => {
      settings = next
    }
  }
}

it('uses actual registry/runtime skill activation and returns reports without private receipts', async () => {
  const f = await fixture()
  expect(getAgentToolDefinitions(f.session.catalog()).map((x) => x.function.name)).not.toContain(
    'office_preflight'
  )
  const skill = await f.invoke('use_skill', { skill_id: 'xlsx' })
  expect(JSON.stringify(skill)).toContain('Prefer advertised office_preflight')
  const result = await f.invoke('office_preflight', { workflow: 'xlsx' })
  expect(result).toMatchObject({
    status: 'success',
    data: { helper: 'preflight', report: { status: 'available' } }
  })
  expect(
    f.observer.mock.calls.map(([run, call, receipt]) => [run, call, receipt.lifecycle])
  ).toEqual([
    ['office-run', 'actual-call', 'started'],
    ['office-run', 'actual-call', 'finished']
  ])
  expect(JSON.stringify(result)).not.toContain('helperDigest')
  expect(JSON.stringify(result)).not.toContain('invocationId')
  expect(spawn).toHaveBeenCalledTimes(1)
})
it.each(['file', 'directory'])(
  'delivers nested instructions when validating a %s target',
  async (kind) => {
    const f = await fixture()
    await mkdir(join(f.workspace, 'nested'))
    await writeFile(join(f.workspace, 'nested/AGENTS.md'), 'SYNTHETIC_NESTED_OFFICE_RULE')
    await writeFile(join(f.workspace, 'nested/book.xlsx'), 'synthetic')
    await f.invoke('use_skill', { skill_id: 'xlsx' })
    const result = await f.invoke('office_validate', {
      path: kind === 'file' ? 'nested/book.xlsx' : 'nested'
    })
    expect(result.status).toBe('success')
    expect(result.modelContent).toContain('SYNTHETIC_NESTED_OFFICE_RULE')
    expect(JSON.stringify(result.data)).not.toContain('SYNTHETIC_NESTED_OFFICE_RULE')
  }
)
it.each([{}, { officeHelperInterpreter: process.execPath, shellIsolation: 'docker' as const }])(
  'keeps unconfigured/Docker tools absent without dispatch',
  async (settings) => {
    const f = await fixture(settings)
    await f.invoke('use_skill', { skill_id: 'xlsx' })
    expect((await f.invoke('office_preflight', { workflow: 'xlsx' })).status).toBe('error')
    expect(spawn).not.toHaveBeenCalled()
  }
)
it('rejects stale configuration, wrong skill workflow, escapes and extra args before spawn', async () => {
  const f = await fixture()
  await f.invoke('use_skill', { skill_id: 'xlsx' })
  for (const [name, args] of [
    ['office_preflight', { workflow: 'docx-comment' }],
    ['office_preflight', { workflow: 'xlsx', interpreter: 'PRIVATE' }],
    ['office_validate', { path: '../assets/preflight.py' }],
    ['office_validate', { path: process.execPath }]
  ] as const)
    expect((await f.invoke(name, args)).status).toBe('error')
  const controller = new AbortController()
  controller.abort()
  expect((await f.invoke('office_preflight', { workflow: 'xlsx' }, controller.signal)).status).toBe(
    'cancelled'
  )
  f.setSettings({
    officeHelperInterpreter: process.execPath,
    officeHelperConfigurationId: 'changed'
  })
  expect((await f.invoke('office_preflight', { workflow: 'xlsx' })).status).toBe('error')
  expect(spawn).not.toHaveBeenCalled()
})
it('requires normal execute approval in the real kernel; denial never spawns', async () => {
  const f = await fixture()
  await f.invoke('use_skill', { skill_id: 'xlsx' })
  const store = new AgentRunStore(f.db)
  let sampled = 0
  const sampler: AgentKernelProviderSampler = async () => ({
    result: { ok: true },
    turn: {
      content: 'Fixture',
      thinking: '',
      thinkingBlocks: [],
      toolCalls:
        sampled++ === 0
          ? [
              {
                id: 'approved-call',
                function: { name: 'office_preflight', arguments: { workflow: 'xlsx' } }
              }
            ]
          : [],
      usage: { promptTokens: 1, completionTokens: 1, doneReason: 'stop' }
    }
  })
  const catalog = f.session.catalog()
  const kernel = new AgentRunKernel(store, undefined, sampler)
  const running = kernel.start({
    id: 'denied-run',
    threadId: 'fixture-thread',
    profile: agentRunProfile(catalog),
    provider: 'ollama',
    model: 'fixture',
    catalog,
    workspaceRoot: f.workspace,
    messages: [{ role: 'user', content: 'Synthetic preflight' }],
    request: {
      target: { providerKind: 'ollama', model: 'fixture' },
      maxOutputTokens: 1000,
      purpose: 'conversation'
    },
    maxToolRounds: 3,
    permissionMode: 'always-ask',
    toolRouter: f.session.router
  })
  await vi.waitFor(() => expect(store.listPendingInteractions('denied-run')).toHaveLength(1))
  kernel.resolveInteraction(store.listPendingInteractions('denied-run')[0].id, { approved: false })
  await running
  expect(spawn).not.toHaveBeenCalled()
})
it('selection validates explicit files only and does not execute', async () => {
  expect(await validateOfficeInterpreter(process.execPath)).toBeTruthy()
  expect(await validateOfficeInterpreter(undefined)).toBeUndefined()
  await expect(validateOfficeInterpreter('python')).rejects.toThrow()
  await expect(validateOfficeInterpreter(tmpdir())).rejects.toThrow()
  expect(spawn).not.toHaveBeenCalled()
})

it('requires workspace and execute capability independently of configuration and loaded skill', () => {
  for (const options of [
    { surface: 'conversation' as const, officeHelpersAvailable: true, activeSkillIds: ['xlsx'] },
    {
      surface: 'conversation' as const,
      officeHelpersAvailable: true,
      activeSkillIds: ['xlsx'],
      workspaceRoot: '/fixture',
      capabilities: ['skills' as const]
    }
  ])
    expect(
      getAgentToolDefinitions(options).some((tool) => tool.function.name.startsWith('office_'))
    ).toBe(false)
})
