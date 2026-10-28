import { describe, expect, it, vi } from 'vitest'
import { getAgentToolEntry, type AgentToolCatalogOptions } from '../../shared/agentToolCatalog'
import {
  editingToolDefinitions,
  workspaceReadToolDefinitions
} from '../../shared/agentToolDefinitions'
import { OutsideProjectError } from '../utils/workspacePaths'
import {
  AgentToolExecutionError,
  AgentToolRegistry,
  externalSchemaIssues,
  normalizeAgentToolArguments,
  prepareAgentToolCall,
  validateAgentToolArguments,
  type AgentToolExecutor
} from './agentToolRegistry'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import { toolExecutionSucceeded } from '../../shared/agentRuntime'

const registry = new AgentToolRegistry()

function input(
  name: string,
  args: Record<string, unknown>,
  signal = new AbortController().signal,
  catalog: AgentToolCatalogOptions = { surface: 'conversation', webSearchEnabled: true }
) {
  return {
    catalog,
    call: { id: 'call-1', name, arguments: args },
    title: 'Test tool',
    context: { runId: 'run-1', signal }
  }
}

describe('AgentToolRegistry', () => {
  it.each(['claude-edit', 'search-replace', 'structured-edit'] as const)(
    'accepts a %s exact edit that omits replace_all, which defaults to one match',
    (dialect) => {
      const edit = editingToolDefinitions(dialect)[0]
      expect(
        validateAgentToolArguments(edit, { file_path: 'a.ts', old_string: 'a', new_string: 'b' })
      ).toEqual([])
    }
  )

  it('takes correlation from the prepared call and trusted run context, not arguments', async () => {
    const request = input('wait', {
      seconds: 1,
      toolCallId: 'argument-spoof',
      runId: 'argument-run'
    })
    const executor = vi.fn<AgentToolExecutor>(async () => ({}))
    await registry.execute(
      { ...request, context: { ...request.context, toolCallId: 'context-spoof' } },
      executor
    )
    expect(executor.mock.calls[0][1]).toMatchObject({ runId: 'run-1', toolCallId: 'call-1' })
    expect(request.context).not.toHaveProperty('toolCallId')
  })

  it('keeps distinct concurrent call IDs in private executor callbacks', async () => {
    const local = new AgentToolRegistry()
    const seen: Array<{ runId: string; toolCallId?: string }> = []
    const releases: Array<() => void> = []
    const run = (id: string) => {
      const request = input('tool_output', { handle: id })
      request.call.id = id
      return local.execute(request, async (_args, context) => {
        const observe = () => seen.push({ runId: context.runId, toolCallId: context.toolCallId })
        await new Promise<void>((resolve) => releases.push(resolve))
        observe()
        return {}
      })
    }
    const first = run('first')
    const second = run('second')
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[1]()
    releases[0]()
    await Promise.all([first, second])
    expect(seen).toEqual([
      { runId: 'run-1', toolCallId: 'second' },
      { runId: 'run-1', toolCallId: 'first' }
    ])
  })

  it('snapshots queued correlation despite caller context and call mutation', async () => {
    const local = new AgentToolRegistry()
    let release!: () => void
    const blocking = local.execute(input('wait', { seconds: 1 }), async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {}
    })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const request = input('wait', { seconds: 1 })
    request.call.id = 'queued-call'
    const executor = vi.fn<AgentToolExecutor>(async () => ({}))
    const pending = local.execute(request, executor)
    request.context.runId = 'changed-run'
    request.call.id = 'changed-call'
    release()
    await Promise.all([blocking, pending])
    expect(executor.mock.calls[0][1]).toMatchObject({ runId: 'run-1', toolCallId: 'queued-call' })
  })

  it('does not invent correlation for direct handler invocations', async () => {
    const handlers = new AgentToolHandlerRegistry()
    const observe = vi.fn()
    handlers.register('direct', async ({ context }) => {
      observe(context)
      return toolExecutionSucceeded({ title: 'Direct', data: {} })
    })
    await handlers.execute({
      name: 'direct',
      title: 'Direct',
      arguments: { toolCallId: 'spoof' },
      context: { runId: 'internal', signal: new AbortController().signal }
    })
    expect(observe.mock.calls[0][0]).not.toHaveProperty('toolCallId')
  })

  it('rejects unavailable tools without calling an executor', async () => {
    const executor = vi.fn()
    const result = await registry.execute(input('not_a_tool', {}), executor)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('unknown_tool')
    expect(executor).not.toHaveBeenCalled()
  })

  it('validates required arguments before side effects', async () => {
    const executor = vi.fn()
    const missing = await registry.execute(input('shell', {}), executor)
    expect(missing.error?.code).toBe('invalid_arguments')
    expect(missing.error?.recoveryAction).toBe('correct_input')
    expect(missing.error?.message).toContain('command')
    expect(executor).not.toHaveBeenCalled()
  })

  it('reports all nested schema errors in one model-visible result', async () => {
    const executor = vi.fn()
    const result = await registry.execute(
      input('ask_user', {
        questions: [
          { question: 'First?', options: [1, 2, 3, 4, 5].map((n) => ({ label: String(n) })) },
          { id: 'second' },
          { id: 'third', question: 'Third?' },
          { id: 'fourth', question: 'Fourth?' }
        ]
      }),
      executor
    )

    expect(result.error?.message).toContain('questions[0].options must contain at most 4')
    expect(result.error?.message).toContain('questions[1].question')
    expect(result.error?.message).toContain('at most 3')
    expect(executor).not.toHaveBeenCalled()
  })

  it('rejects removed model-specific editing aliases', async () => {
    const executor = vi.fn(async () => ({ changed: true }))
    const result = await registry.execute(
      input(
        'EDIT',
        {
          filePath: 'src/app.ts',
          oldText: 'before',
          newText: 'after',
          replaceAll: 'false',
          access_level: 'auto'
        },
        new AbortController().signal,
        {
          surface: 'conversation' as const,
          workspaceRoot: '/project'
        }
      ),
      executor
    )

    expect(result).toMatchObject({ status: 'error', error: { code: 'unknown_tool' } })
    expect(executor).not.toHaveBeenCalled()
  })

  it('normalizes successful values and typed permission denials', async () => {
    const success = await registry.execute(input('wait', { seconds: 1 }), async () => ({
      waitedSeconds: 1
    }))
    expect(success).toMatchObject({ status: 'success', data: { waitedSeconds: 1 } })

    const denied = await registry.execute(input('wait', { seconds: 1 }), async () => {
      throw new AgentToolExecutionError('permission_denied', 'Denied by user')
    })
    expect(denied.status).toBe('denied')
    expect(denied.error?.code).toBe('permission_denied')
  })

  it('does not enter the executor after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const executor = vi.fn()
    const result = await registry.execute(
      input('wait', { seconds: 1 }, controller.signal),
      executor
    )
    expect(result.status).toBe('cancelled')
    expect(executor).not.toHaveBeenCalled()
  })

  it('classifies missing filesystem resources as recoverable not-found errors', async () => {
    const result = await registry.execute(input('wait', { seconds: 1 }), async () => {
      throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' })
    })
    expect(result).toMatchObject({ status: 'error', error: { code: 'not_found', retryable: true } })
  })

  it('settles cancellation when an executor ignores AbortSignal', async () => {
    const controller = new AbortController()
    let releaseExecutor!: () => void
    const executor = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseExecutor = () => resolve({ waitedSeconds: 1 })
        })
    )
    const executing = registry.execute(input('wait', { seconds: 1 }, controller.signal), executor)

    await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce())
    controller.abort()

    await expect(
      Promise.race([executing, new Promise((resolve) => setTimeout(resolve, 100))])
    ).resolves.toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } })
    releaseExecutor()
  })

  it('runs parallel reads together and waits before exclusive execution', async () => {
    const localRegistry = new AgentToolRegistry()
    const releases: Array<() => void> = []
    const started: string[] = []
    const read = (label: string) =>
      localRegistry.execute(input('tool_output', { handle: label }), async () => {
        started.push(label)
        await new Promise<void>((resolve) => releases.push(resolve))
        return { content: label }
      })
    const first = read('first')
    const second = read('second')
    await vi.waitFor(() => expect(started).toEqual(['first', 'second']))

    const exclusive = localRegistry.execute(input('shell', { command: 'echo ok' }), async () => {
      started.push('exclusive')
      return { stdout: 'ok' }
    })
    await Promise.resolve()
    expect(started).not.toContain('exclusive')

    releases.splice(0).forEach((release) => release())
    await Promise.all([first, second, exclusive])
    expect(started.at(-1)).toBe('exclusive')
  })
})

describe('tool refusals', () => {
  const workspace: AgentToolCatalogOptions = {
    surface: 'conversation',
    workspaceRoot: '/project',
    editingDialect: 'structured-edit'
  }

  it('labels a path outside the project as out of scope, with a recovery that keeps it refused', async () => {
    for (const catalog of [workspace, { ...workspace, sessionRole: 'manager' as const }]) {
      const result = await registry.execute(
        input('read', { path: '../other/notes.md' }, new AbortController().signal, catalog),
        async () => {
          throw new OutsideProjectError('Path is outside the project: ../other/notes.md')
        }
      )
      expect(result).toMatchObject({
        status: 'error',
        error: {
          code: 'workspace_scope',
          message: 'Path is outside the project: ../other/notes.md',
          retryable: false,
          recoveryAction: 'change_strategy'
        }
      })
      const recovery = result.error?.recovery ?? ''
      expect(recovery).toContain('not granted to this chat')
      expect(recovery).toContain('Do not try to reach the folder another way')
      expect(recovery).toContain('add the folder as a project in SideKick')
      // Only a chat that can start other chats is told to; a worker or sub-agent cannot.
      expect(recovery.includes('start_session')).toBe(catalog.sessionRole === 'manager')
      expect(result.modelContent).toContain('workspace_scope')
    }
  })

  it('keeps unexplained executor failures internal', async () => {
    const result = await registry.execute(input('wait', { seconds: 1 }), async () => {
      throw new Error('Unexpected state')
    })
    expect(result.error).toMatchObject({ code: 'internal', message: 'Unexpected state' })
  })

  it.each([
    ['apply_patch', 'structured-edit', 'edit', 'file_path, old_string, new_string'],
    ['apply_patch', 'claude-edit', 'Edit', 'file_path, old_string, new_string'],
    ['Edit', 'apply-patch', 'apply_patch', 'patch'],
    ['str_replace_based_edit_tool', 'search-replace', 'search_replace', 'file_path'],
    ['write_file', 'structured-edit', 'write', 'file_path, content'],
    ['ask_user_question', 'structured-edit', 'ask_user', 'questions'],
    ['AskUserQuestion', 'structured-edit', 'ask_user', 'questions'],
    ['exec_command', 'structured-edit', 'shell', 'command'],
    ['Bash', 'structured-edit', 'shell', 'command'],
    ['TodoWrite', 'structured-edit', 'manage_todo_list', 'operation'],
    ['WebFetch', 'structured-edit', 'web_fetch', 'url']
  ] as const)(
    'names the SideKick tool for %s from another harness (%s)',
    async (name, editingDialect, equivalent, required) => {
      const executor = vi.fn()
      const result = await registry.execute(
        input(name, {}, new AbortController().signal, { ...workspace, editingDialect }),
        executor
      )
      expect(result.error).toMatchObject({
        code: 'unknown_tool',
        recoveryAction: 'change_strategy'
      })
      expect(result.error?.message).toBe(
        `Tool is not available in this run: ${name}. SideKick's equivalent is ${equivalent}.`
      )
      expect(result.error?.recovery).toContain(`Call ${equivalent}`)
      expect(result.error?.recovery).toContain(required)
      expect(executor).not.toHaveBeenCalled()
    }
  )

  it('says how read and shell cover listing and searching', async () => {
    const glob = await registry.execute(input('Glob', {}, undefined, workspace), vi.fn())
    expect(glob.error?.recovery).toContain('Call read with a directory path, and glob')
    const grep = await registry.execute(input('grep_search', {}, undefined, workspace), vi.fn())
    expect(grep.error?.recovery).toContain('Call shell to run rg')
  })

  it('names no equivalent that this run does not have', async () => {
    const research: AgentToolCatalogOptions = { surface: 'research' }
    for (const name of ['apply_patch', 'Bash', 'frobnicate']) {
      const result = await registry.execute(
        input(name, {}, new AbortController().signal, research),
        vi.fn()
      )
      expect(result.error).toMatchObject({
        code: 'unknown_tool',
        message: `Tool is not available in this run: ${name}`,
        recovery: 'Choose a tool from the current tool catalog.'
      })
    }
  })
})

describe('argument names from other harnesses', () => {
  const read = workspaceReadToolDefinitions()[0]
  const [edit] = editingToolDefinitions('structured-edit')
  const shell = getAgentToolEntry({ surface: 'conversation' }, 'shell')!.definition

  it.each([
    [{ file_path: 'src/a.ts' }, 'file_path → path'],
    [{ filePath: 'src/a.ts' }, 'filePath → path'],
    [{ filepath: 'src/a.ts' }, 'filepath → path'],
    [{ absolute_path: 'src/a.ts' }, 'absolute_path → path'],
    [{ target_file: 'src/a.ts' }, 'target_file → path'],
    [{ dir_path: 'src/a.ts' }, 'dir_path → path']
  ])('repairs read %j to path', (args, repair) => {
    const normalized = normalizeAgentToolArguments(read, args)
    expect(normalized).toEqual({ arguments: { path: 'src/a.ts' }, repairs: [repair] })
    expect(validateAgentToolArguments(read, normalized.arguments)).toEqual([])
  })

  it('still repairs path to file_path for the editing tools', () => {
    expect(
      normalizeAgentToolArguments(edit, { path: 'a.ts', oldText: 'a', newString: 'b' })
    ).toEqual({
      arguments: { file_path: 'a.ts', old_string: 'a', new_string: 'b' },
      repairs: ['path → file_path', 'oldText → old_string', 'newString → new_string']
    })
  })

  it('reads a line offset and count as start and end lines', () => {
    expect(normalizeAgentToolArguments(read, { file_path: 'a.ts', offset: 40, limit: 20 })).toEqual(
      {
        arguments: { path: 'a.ts', start_line: 40, end_line: 59 },
        repairs: ['file_path → path', 'offset → start_line', 'limit → end_line']
      }
    )
    // A 0-based offset starts at the first line rather than being refused.
    expect(normalizeAgentToolArguments(read, { path: 'a.ts', offset: 0, limit: 5 })).toEqual({
      arguments: { path: 'a.ts', start_line: 1, end_line: 5 },
      repairs: ['offset → start_line', 'limit → end_line']
    })
    expect(normalizeAgentToolArguments(read, { path: 'a.ts', limit: 30 }).arguments).toEqual({
      path: 'a.ts',
      end_line: 30
    })
  })

  it('leaves line ranges it cannot read unambiguously for validation to report', () => {
    for (const args of [
      { path: 'a.ts', offset: 10, start_line: 3 },
      { path: 'a.ts', offset: -1 },
      { path: 'a.ts', limit: 0 },
      { path: 'a.ts', offset: '10' }
    ]) {
      expect(normalizeAgentToolArguments(read, args), JSON.stringify(args)).toMatchObject({
        arguments: args,
        repairs: []
      })
    }
  })

  it('repairs Codex and Claude Code shell argument names', () => {
    expect(
      normalizeAgentToolArguments(shell, {
        command: 'npm test',
        workdir: 'packages/app',
        run_in_background: true
      })
    ).toEqual({
      arguments: { command: 'npm test', cwd: 'packages/app', background: true },
      repairs: ['workdir → cwd', 'run_in_background → background']
    })
  })

  it('takes ask_user options written as plain labels', () => {
    // "options[0] must be object" lost the model a round.
    const askUser = getAgentToolEntry({ surface: 'conversation' }, 'ask_user')!.definition
    const normalized = normalizeAgentToolArguments(askUser, {
      questions: [{ question: 'Which theme?', options: ['Light', { label: 'Dark' }] }]
    })
    expect(normalized).toEqual({
      arguments: {
        questions: [{ question: 'Which theme?', options: [{ label: 'Light' }, { label: 'Dark' }] }]
      },
      repairs: ['questions[0].options[0]: text → label']
    })
    expect(validateAgentToolArguments(askUser, normalized.arguments)).toEqual([])
  })

  it('does not choose between two spellings of one argument', () => {
    const normalized = normalizeAgentToolArguments(read, { file_path: 'a.ts', filePath: 'b.ts' })
    expect(normalized).toEqual({ arguments: { file_path: 'a.ts', filePath: 'b.ts' }, repairs: [] })
    expect(validateAgentToolArguments(read, normalized.arguments)[0]).toMatchObject({
      path: 'path',
      code: 'required'
    })
    // The argument the schema names wins over an alias sent beside it.
    expect(normalizeAgentToolArguments(read, { path: 'a.ts', file_path: 'b.ts' })).toEqual({
      arguments: { path: 'a.ts', file_path: 'b.ts' },
      repairs: []
    })
  })

  it('executes a repaired read and records the repair when validation still fails', async () => {
    const catalog: AgentToolCatalogOptions = { surface: 'conversation', workspaceRoot: '/project' }
    const executor = vi.fn(async (args: Record<string, unknown>) => args)
    const result = await registry.execute(
      input('read', { file_path: 'src/a.ts', offset: 2, limit: 2 }, undefined, catalog),
      executor
    )
    expect(result.status).toBe('success')
    expect(executor.mock.calls[0][0]).toEqual({ path: 'src/a.ts', start_line: 2, end_line: 3 })

    const prepared = prepareAgentToolCall(catalog, {
      id: 'bad',
      name: 'read',
      arguments: { file_path: 'src/a.ts', max_entries: 0 }
    })
    expect(prepared.repairs).toEqual(['file_path → path'])
    const invalid = await registry.execute(
      input('read', { file_path: 'src/a.ts', max_entries: 0 }, undefined, catalog),
      vi.fn()
    )
    expect(invalid.error?.recovery).toContain('SideKick normalized: file_path → path.')
  })
})

describe('externalSchemaIssues', () => {
  const schema = {
    type: 'object',
    required: ['item'],
    properties: {
      item: { type: 'string', pattern: '^(a+)+$' },
      quantity: { type: 'integer', minimum: 1 }
    }
  }

  it("finds what a web page's schema can check cheaply", () => {
    expect(externalSchemaIssues(schema, { quantity: 0 })?.map((issue) => issue.code)).toEqual([
      'required',
      'minimum'
    ])
    expect(externalSchemaIssues(schema, { item: 'apple', quantity: 2 })).toEqual([])
  })

  it('never runs a page-supplied pattern', () => {
    // This pattern backtracks catastrophically on this input; checking it would stall the main process.
    expect(externalSchemaIssues(schema, { item: `${'a'.repeat(40)}!` })).toEqual([])
  })

  it('gives up on a schema whose alternatives multiply beyond its budget', () => {
    let nested: Record<string, unknown> = { type: 'string' }
    for (let depth = 0; depth < 40; depth++) nested = { anyOf: [nested, nested] }
    expect(externalSchemaIssues(nested, 1)).toBeNull()
  })

  it('reports a malformed schema as an issue rather than failing on it', () => {
    expect(externalSchemaIssues({ anyOf: [null] }, {})).toEqual([
      { path: '', code: 'schema', message: 'arguments has a malformed schema' }
    ])
    expect(externalSchemaIssues({ properties: { a: { anyOf: [false] } } }, { a: 1 })).toEqual([
      { path: 'a', code: 'schema', message: 'a is not allowed by schema' }
    ])
    expect(externalSchemaIssues({ anyOf: [true, 7] }, { a: 1 })).toEqual([])
  })
})
