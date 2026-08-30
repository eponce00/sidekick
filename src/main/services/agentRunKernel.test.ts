import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentRunProfile, type AgentToolCatalogOptions } from '../../shared/agentToolCatalog'
import { toolExecutionFailed, toolExecutionSucceeded } from '../../shared/agentRuntime'
import { projectAgentRunEvents } from '../../shared/agentEventProjection'
import type { ProviderChatRequest, ProviderStreamChunk } from '../../shared/providerRuntime'
import { applyDatabaseSchema } from '../bootstrap/database'
import {
  AgentRunKernel,
  type AgentKernelProviderSampler,
  type AgentKernelModelTurn,
  type StartAgentKernelRunInput
} from './agentRunKernel'
import { AgentRunStore } from './agentRunStore'

function sampledTurn(
  turn: Partial<AgentKernelModelTurn>,
  chunks: ProviderStreamChunk[] = []
): AgentKernelProviderSampler {
  return vi.fn(async (_request, _signal, onChunk) => {
    for (const chunk of chunks) onChunk(chunk)
    return {
      result: { ok: true },
      turn: {
        content: '',
        thinking: '',
        thinkingBlocks: [],
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5, doneReason: 'stop' },
        ...turn
      }
    }
  })
}

function sequence(...samplers: AgentKernelProviderSampler[]): AgentKernelProviderSampler {
  let index = 0
  return async (request, signal, onChunk) => {
    const sampler = samplers[Math.min(index, samplers.length - 1)]
    index++
    return sampler(request, signal, onChunk)
  }
}

describe('AgentRunKernel', () => {
  let db: Database.Database
  let store: AgentRunStore
  let catalog: AgentToolCatalogOptions

  beforeEach(() => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    store = new AgentRunStore(db)
    catalog = { surface: 'conversation', webSearchEnabled: false }
  })

  function input(
    toolRouter: StartAgentKernelRunInput['toolRouter'] = { execute: vi.fn() }
  ): StartAgentKernelRunInput {
    return {
      id: 'run-1',
      threadId: 'thread-1',
      profile: agentRunProfile(catalog),
      provider: 'ollama',
      model: 'test-model',
      catalog,
      messages: [{ role: 'user', content: 'Hello' }],
      request: {
        target: { providerKind: 'ollama', model: 'test-model' },
        maxOutputTokens: 1_024,
        purpose: 'conversation'
      },
      maxToolRounds: 1_000,
      permissionMode: 'full-access',
      toolRouter
    }
  }

  it('streams durable deltas and completes a text-only run', async () => {
    const published: string[] = []
    const sampler = sampledTurn({ content: 'Hello world' }, [
      { message: { content: 'Hello ' } },
      { message: { content: 'world' }, done: true, done_reason: 'stop' }
    ])
    const kernel = new AgentRunKernel(store, undefined, sampler, (event) => {
      published.push(event.type)
    })

    const result = await kernel.start(input())

    expect(result).toMatchObject({ phase: 'completed', content: 'Hello world', toolRounds: 0 })
    expect(store.get('run-1')?.phase).toBe('completed')
    expect(store.listEvents('run-1').map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        'run.started',
        'assistant.delta',
        'assistant.completed',
        'usage.updated',
        'run.completed'
      ])
    )
    expect(published).toContain('assistant.delta')
  })

  it('continues an active goal after a terminal text turn', async () => {
    const sampler = sequence(
      sampledTurn({ content: 'I finished the first step.' }),
      sampledTurn({ content: 'The verified goal is complete.' })
    )
    const kernel = new AgentRunKernel(store, undefined, sampler)
    const goalController = {
      afterTerminalTurn: vi
        .fn()
        .mockResolvedValueOnce({ continue: true, prompt: 'Continue the durable goal.' })
        .mockResolvedValueOnce({ continue: false })
    }

    const result = await kernel.start({ ...input(), goalController })

    expect(result).toMatchObject({
      phase: 'completed',
      content: 'I finished the first step.\n\nThe verified goal is complete.'
    })
    expect(goalController.afterTerminalTurn).toHaveBeenCalledTimes(2)
    expect(store.listEvents('run-1')).toContainEqual(
      expect.objectContaining({
        type: 'run.retrying',
        payload: expect.objectContaining({ reason: 'goal_continuation' })
      })
    )
  })

  it('keeps an unverified completion provisional and exposes durable verification state', async () => {
    const sampler = sequence(
      sampledTurn({ content: 'The change is done.' }),
      sampledTurn({ content: 'The change is now verified.' })
    )
    const kernel = new AgentRunKernel(store, undefined, sampler)
    const summary = {
      status: 'unverified' as const,
      workspaceRoot: '/project',
      baselineRevision: 0,
      currentRevision: 1,
      changedPaths: ['app.ts'],
      evidence: [],
      suggestedChecks: [],
      headline: 'Workspace changes have not been verified.'
    }
    const verificationController = {
      afterTerminalTurn: vi
        .fn()
        .mockResolvedValueOnce({ continue: true, prompt: 'Run verification.', summary })
        .mockResolvedValueOnce({
          continue: false,
          summary: { ...summary, status: 'passed', headline: 'Typecheck passed.' }
        })
    }

    const result = await kernel.start({ ...input(), verificationController })
    const projection = projectAgentRunEvents(store.listEvents('run-1'))

    expect(result.content).toBe('The change is now verified.')
    expect(projection.content).toBe('The change is now verified.')
    expect(projection.segments.at(-1)).toMatchObject({
      type: 'verification',
      verification: { status: 'passed', headline: 'Typecheck passed.' }
    })
    expect(store.listEvents('run-1')).toContainEqual(
      expect.objectContaining({
        type: 'run.retrying',
        payload: expect.objectContaining({ reason: 'workspace_verification_required' })
      })
    )
  })

  it('owns the complete model-tool-continuation loop', async () => {
    const router = { execute: vi.fn(async () => ({ waitedSeconds: 1 })) }
    const sampler = sequence(
      sampledTurn({
        content: 'Working privately. ',
        toolCalls: [
          {
            id: 'wait-1',
            function: { name: 'wait', arguments: { seconds: 1, reason: 'test' } }
          }
        ],
        usage: { promptTokens: 10, completionTokens: 2, doneReason: 'tool_calls' }
      }),
      sampledTurn({ content: 'Finished' })
    )
    const kernel = new AgentRunKernel(store, undefined, sampler)

    const result = await kernel.start(input(router))

    expect(result).toMatchObject({
      phase: 'completed',
      content: 'Working privately. Finished',
      finalResponse: 'Finished',
      toolRounds: 1
    })
    expect(router.execute).toHaveBeenCalledWith(
      'wait',
      { seconds: 1, reason: 'test' },
      expect.objectContaining({ runId: 'run-1', signal: expect.any(AbortSignal) })
    )
    const toolResult = result.messages.find(({ role }) => role === 'tool')
    expect(toolResult?.tool_call_id).toBe('wait-1')
    expect(toolResult?.content).toContain('waitedSeconds')
    expect(store.listEvents('run-1').map(({ type }) => type)).toEqual(
      expect.arrayContaining(['tool.pending', 'tool.running', 'tool.completed'])
    )
  })

  it('carries typed tool media into the next model turn and durable result event', async () => {
    const media = [
      {
        type: 'image' as const,
        mimeType: 'image/png' as const,
        name: 'viewport.png',
        source: { type: 'file' as const, path: 'C:\\artifacts\\viewport.png' }
      }
    ]
    const router = {
      execute: vi.fn(async () =>
        toolExecutionSucceeded({
          title: 'Wait',
          modelContent: 'Captured viewport.',
          media
        })
      )
    }
    const continuation = sampledTurn({ content: 'I inspected the screenshot.' })
    const sampler = sequence(
      sampledTurn({
        toolCalls: [
          {
            id: 'wait-with-image',
            function: { name: 'wait', arguments: { seconds: 1, reason: 'capture' } }
          }
        ],
        usage: { promptTokens: 10, completionTokens: 2, doneReason: 'tool_calls' }
      }),
      continuation
    )
    const kernel = new AgentRunKernel(store, undefined, sampler)

    const result = await kernel.start(input(router))
    const toolMessage = result.messages.find(({ role }) => role === 'tool')
    const completed = store.listEvents('run-1').find((event) => event.type === 'tool.completed')

    expect(toolMessage).toMatchObject({
      tool_call_id: 'wait-with-image',
      content: 'Captured viewport.',
      media
    })
    expect(completed?.payload).toMatchObject({ result: { media } })
    expect(continuation).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([expect.objectContaining({ role: 'tool', media })])
      }),
      expect.any(AbortSignal),
      expect.any(Function)
    )
  })

  it.each(['length', 'max_tokens', 'max-output-tokens'])(
    'does not execute a tool batch when the provider stops for %s',
    async (doneReason) => {
      const router = { execute: vi.fn(async () => ({ waitedSeconds: 99 })) }
      const sampler = sequence(
        sampledTurn({
          toolCalls: [
            {
              id: 'possibly-truncated',
              function: { name: 'wait', arguments: { seconds: 99, reason: 'looks valid' } }
            }
          ],
          usage: { promptTokens: 10, completionTokens: 1_024, doneReason }
        }),
        sampledTurn({ content: 'Retried safely without running the incomplete call.' })
      )
      const kernel = new AgentRunKernel(store, undefined, sampler)

      const result = await kernel.start(input(router))
      const events = store.listEvents('run-1')
      const toolResult = result.messages.find(({ role }) => role === 'tool')

      expect(result).toMatchObject({ phase: 'completed', toolRounds: 1 })
      expect(router.execute).not.toHaveBeenCalled()
      expect(toolResult?.content).toContain('output_truncated')
      expect(toolResult?.content).toContain('Do not assume any call from this batch ran')
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'run.retrying',
          payload: expect.objectContaining({
            reason: 'truncated_tool_batch',
            doneReason,
            toolCallCount: 1
          })
        })
      )
      expect(events.some(({ type }) => type === 'tool.running')).toBe(false)
    }
  )

  it('assigns unique durable identities when a provider repeats tool-call ids', async () => {
    const router = { execute: vi.fn(async () => ({ waitedSeconds: 1 })) }
    const sampler = sequence(
      sampledTurn({
        toolCalls: [
          {
            id: 'duplicate',
            function: { name: 'wait', arguments: { seconds: 1, reason: 'first' } }
          },
          {
            id: 'duplicate',
            function: { name: 'wait', arguments: { seconds: 1, reason: 'second' } }
          }
        ]
      }),
      sampledTurn({ content: 'Both calls finished' })
    )
    const kernel = new AgentRunKernel(store, undefined, sampler)

    const result = await kernel.start(input(router))
    const toolMessageIds = result.messages
      .filter(({ role }) => role === 'tool')
      .map(({ tool_call_id }) => tool_call_id)
    const completedIds = store
      .listEvents('run-1')
      .filter(({ type }) => type === 'tool.completed')
      .map(({ payload }) => payload.toolCallId)

    expect(router.execute).toHaveBeenCalledTimes(2)
    expect(new Set(toolMessageIds).size).toBe(2)
    expect(new Set(completedIds).size).toBe(2)
  })

  it('executes a contiguous batch of catalog-safe read tools concurrently', async () => {
    const started: string[] = []
    const releases: Array<() => void> = []
    const router = {
      execute: vi.fn(async (_name: string, args: Record<string, unknown>) => {
        started.push(String(args.handle))
        await new Promise<void>((resolve) => releases.push(resolve))
        return { content: String(args.handle) }
      })
    }
    const sampler = sequence(
      sampledTurn({
        toolCalls: [
          { id: 'read-1', function: { name: 'tool_output', arguments: { handle: 'first' } } },
          { id: 'read-2', function: { name: 'tool_output', arguments: { handle: 'second' } } }
        ],
        usage: { promptTokens: 10, completionTokens: 5, doneReason: 'tool_calls' }
      }),
      sampledTurn({ content: 'Both reads finished.' })
    )
    const kernel = new AgentRunKernel(store, undefined, sampler)

    const running = kernel.start(input(router))
    await vi.waitFor(() => expect(started).toEqual(['first', 'second']))
    releases.splice(0).forEach((release) => release())
    const result = await running

    expect(result).toMatchObject({ phase: 'completed', finalResponse: 'Both reads finished.' })
    expect(router.execute).toHaveBeenCalledTimes(2)
    expect(
      store
        .listEvents('run-1')
        .filter(({ type }) => type === 'tool.completed')
        .map(({ payload }) => payload.toolCallId)
    ).toEqual(['read-1', 'read-2'])
  })

  it('requires a research profile to attempt source retrieval before completing', async () => {
    catalog = { surface: 'research', webSearchEnabled: true }
    const router = {
      execute: vi.fn(async () => ({
        results: [{ title: 'Official source', url: 'https://example.com' }]
      }))
    }
    const sampler = sequence(
      sampledTurn({ content: 'An answer from memory' }),
      sampledTurn({
        toolCalls: [
          {
            id: 'search-1',
            function: { name: 'web_search', arguments: { query: 'official evidence' } }
          }
        ]
      }),
      sampledTurn({ content: 'Verified [source](https://example.com)' })
    )
    const kernel = new AgentRunKernel(store, undefined, sampler)
    const runInput = input(router)
    runInput.request.purpose = 'research'

    const result = await kernel.start(runInput)
    const events = store.listEvents('run-1')
    const projection = projectAgentRunEvents(events)

    expect(result).toMatchObject({
      phase: 'completed',
      content: 'Verified [source](https://example.com)',
      toolRounds: 1
    })
    expect(router.execute).toHaveBeenCalledWith(
      'web_search',
      { query: 'official evidence' },
      expect.objectContaining({ runId: 'run-1' })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'run.retrying',
        payload: expect.objectContaining({ reason: 'research_source_required' })
      })
    )
    expect(projection.content).toBe('Verified [source](https://example.com)')
  })

  it('returns an honest result when a research model ignores the source guard', async () => {
    catalog = { surface: 'research', webSearchEnabled: true }
    const sampler = sequence(
      sampledTurn({ content: 'First unsupported answer' }),
      sampledTurn({ content: 'Second unsupported answer' })
    )
    const kernel = new AgentRunKernel(store, undefined, sampler)
    const runInput = input()
    runInput.request.purpose = 'research'

    const result = await kernel.start(runInput)
    const projection = projectAgentRunEvents(store.listEvents('run-1'))

    expect(result.phase).toBe('completed')
    expect(result.content).toContain('did not use the available web research tools')
    expect(projection.content).toBe(result.content)
    expect(projection.content).not.toContain('unsupported answer')
  })

  it('turns unavailable tools into model-visible results instead of crashing the run', async () => {
    const router = { execute: vi.fn() }
    const sampler = sequence(
      sampledTurn({
        toolCalls: [{ id: 'bad-1', function: { name: 'made_up_tool', arguments: {} } }]
      }),
      sampledTurn({ content: 'Recovered' })
    )
    const kernel = new AgentRunKernel(store, undefined, sampler)
    const result = await kernel.start(input(router))

    expect(result.phase).toBe('completed')
    expect(result.messages.find(({ role }) => role === 'tool')?.content).toContain('unknown_tool')
    expect(router.execute).not.toHaveBeenCalled()
  })

  it('stops identical tool failures independently of retryability', async () => {
    let callIndex = 0
    const repeatedCall: AgentKernelProviderSampler = async () => {
      callIndex++
      return {
        result: { ok: true },
        turn: {
          content: '',
          thinking: '',
          thinkingBlocks: [],
          toolCalls: [
            {
              id: `repeated-call-${callIndex}`,
              function: {
                name: 'shell',
                arguments: {
                  title: 'Check page',
                  command: 'curl http://localhost:3000',
                  accessLevel: 'auto'
                }
              }
            }
          ],
          usage: { promptTokens: 10, completionTokens: 5, doneReason: 'tool_calls' }
        }
      }
    }
    const router = {
      execute: vi.fn(async () =>
        toolExecutionFailed({
          title: 'Check page',
          code: 'workspace_scope',
          message: 'Command is outside the workspace',
          retryable: false
        })
      )
    }
    const kernel = new AgentRunKernel(store, undefined, repeatedCall)

    const result = await kernel.start(input(router))

    expect(result.phase).toBe('failed')
    expect(result.error).toContain('stopped after 5 identical failed calls')
    expect(router.execute).toHaveBeenCalledTimes(5)
    expect(result.messages.filter(({ role }) => role === 'tool').at(-1)?.content).toContain(
      'sidekick_tool_guard'
    )
  })

  it('closes every tool call in a batch after one call triggers a hard loop stop', async () => {
    let turnIndex = 0
    const sampler: AgentKernelProviderSampler = async () => {
      turnIndex++
      return {
        result: { ok: true },
        turn: {
          content: '',
          thinking: '',
          thinkingBlocks: [],
          toolCalls: [
            {
              id: `failing-${turnIndex}`,
              function: {
                name: 'shell',
                arguments: { title: 'Fail', command: 'false', accessLevel: 'auto' }
              }
            },
            ...(turnIndex === 5
              ? [
                  {
                    id: 'skipped-after-loop',
                    function: { name: 'wait', arguments: { seconds: 1 } }
                  }
                ]
              : [])
          ],
          usage: { promptTokens: 10, completionTokens: 5, doneReason: 'tool_calls' }
        }
      }
    }
    const router = {
      execute: vi.fn(async () =>
        toolExecutionFailed({
          title: 'Fail',
          code: 'workspace_scope',
          message: 'Outside workspace'
        })
      )
    }
    const kernel = new AgentRunKernel(store, undefined, sampler)

    const result = await kernel.start(input(router))
    const finalToolMessages = result.messages.filter(({ role }) => role === 'tool').slice(-2)

    expect(result.phase).toBe('failed')
    expect(router.execute).toHaveBeenCalledTimes(5)
    expect(finalToolMessages.map(({ tool_call_id }) => tool_call_id)).toEqual([
      'failing-5',
      'skipped-after-loop'
    ])
    expect(finalToolMessages[1].content).toContain('earlier call in this batch')
  })

  it('stops repeated correctable validation failures without invoking the tool', async () => {
    catalog = {
      surface: 'conversation',
      workspaceRoot: '/project',
      capabilities: ['workspace.write']
    }
    let callIndex = 0
    const malformedEdit: AgentKernelProviderSampler = async () => {
      callIndex++
      return {
        result: { ok: true },
        turn: {
          content: '',
          thinking: '',
          thinkingBlocks: [],
          toolCalls: [
            {
              id: `edit-${callIndex}`,
              function: { name: 'apply_patch', arguments: { accessLevel: 'auto' } }
            }
          ],
          usage: { promptTokens: 10, completionTokens: 5, doneReason: 'tool_calls' }
        }
      }
    }
    const router = { execute: vi.fn() }
    const kernel = new AgentRunKernel(store, undefined, malformedEdit)

    const result = await kernel.start(input(router))

    expect(result.phase).toBe('failed')
    expect(result.error).toContain('5 identical failed calls')
    expect(router.execute).not.toHaveBeenCalled()
    expect(result.messages.filter(({ role }) => role === 'tool')[0].content).toContain('patch')
  })

  it('keeps the canonical editing contract after legacy tool calls fail', async () => {
    catalog = {
      surface: 'conversation',
      workspaceRoot: '/project',
      capabilities: ['workspace.write']
    }
    const malformed = (id: string) =>
      sampledTurn({
        toolCalls: [
          {
            id,
            function: {
              name: 'edit',
              arguments: { file_path: 'src/app.ts', accessLevel: 'auto' }
            }
          }
        ]
      })
    const patched: AgentKernelProviderSampler = async (request) => {
      expect(
        (request.tools as Array<{ function: { name: string } }>).map(
          ({ function: definition }) => definition.name
        )
      ).toContain('apply_patch')
      return {
        result: { ok: true },
        turn: {
          content: '',
          thinking: '',
          thinkingBlocks: [],
          toolCalls: [
            {
              id: 'patch-1',
              function: {
                name: 'apply_patch',
                arguments: {
                  patch:
                    '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-before\n+after\n*** End Patch',
                  accessLevel: 'auto'
                }
              }
            }
          ],
          usage: { promptTokens: 10, completionTokens: 5, doneReason: 'tool_calls' }
        }
      }
    }
    const router = { execute: vi.fn(async () => ({ ok: true, changed: true })) }
    const kernel = new AgentRunKernel(
      store,
      undefined,
      sequence(malformed('edit-1'), malformed('edit-2'), patched, sampledTurn({ content: 'Done' }))
    )
    const runInput = input(router)
    runInput.catalog = () => ({ ...catalog })

    const result = await kernel.start(runInput)

    expect(result).toMatchObject({ phase: 'completed', content: 'Done' })
    expect(router.execute).toHaveBeenCalledTimes(1)
    expect(
      store
        .listEvents('run-1')
        .filter(({ type }) => type === 'run.retrying')
        .map(({ payload }) => payload.reason)
    ).not.toContain('editing_contract_switched')
  })

  it('does not calibrate or revive removed exact-edit tools', async () => {
    catalog = {
      surface: 'conversation',
      workspaceRoot: '/project',
      capabilities: ['workspace.write']
    }
    const ambiguous = (id: string) =>
      sampledTurn({
        toolCalls: [
          {
            id,
            function: {
              name: 'edit',
              arguments: {
                file_path: 'src/app.ts',
                old_string: 'color: legacy;',
                new_string: 'color: current;',
                replace_all: false,
                accessLevel: 'auto'
              }
            }
          }
        ]
      })
    const patched: AgentKernelProviderSampler = async (request) => {
      expect(
        (request.tools as Array<{ function: { name: string } }>).map(
          ({ function: definition }) => definition.name
        )
      ).toContain('apply_patch')
      return {
        result: { ok: true },
        turn: {
          content: '',
          thinking: '',
          thinkingBlocks: [],
          toolCalls: [
            {
              id: 'ambiguity-patch',
              function: {
                name: 'apply_patch',
                arguments: {
                  patch:
                    '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-color: legacy;\n+color: current;\n*** End Patch',
                  accessLevel: 'auto'
                }
              }
            }
          ],
          usage: { promptTokens: 10, completionTokens: 5, doneReason: 'tool_calls' }
        }
      }
    }
    const router = {
      execute: vi.fn(async (name: string) =>
        name === 'edit'
          ? toolExecutionFailed({
              title: 'edit src/app.ts',
              code: 'conflict',
              message: 'old_string has 4 matches',
              retryable: true,
              recoveryAction: 'correct_input',
              data: {
                ok: false,
                failure: { code: 'multiple_matches', matchCount: 4 }
              }
            })
          : { ok: true, changed: true }
      )
    }
    const kernel = new AgentRunKernel(
      store,
      undefined,
      sequence(
        ambiguous('ambiguous-1'),
        ambiguous('ambiguous-2'),
        patched,
        sampledTurn({ content: 'Recovered safely.' })
      )
    )
    const runInput = input(router)
    runInput.catalog = () => ({ ...catalog })

    const result = await kernel.start(runInput)

    expect(result).toMatchObject({ phase: 'completed', content: 'Recovered safely.' })
    expect(router.execute).toHaveBeenCalledTimes(1)
    expect(
      store
        .listEvents('run-1')
        .filter(({ type }) => type === 'run.retrying')
        .map(({ payload }) => payload.reason)
    ).not.toContain('editing_contract_calibration_started')
  })

  it('returns malformed provider JSON as a tool result and lets the model recover', async () => {
    const router = { execute: vi.fn() }
    const sampler = sequence(
      sampledTurn({
        toolCalls: [
          {
            id: 'broken-json',
            function: { name: 'wait', arguments: '{"seconds":' }
          }
        ]
      }),
      sampledTurn({ content: 'Recovered from the malformed call.' })
    )
    const kernel = new AgentRunKernel(store, undefined, sampler)

    const result = await kernel.start(input(router))

    expect(result.phase).toBe('completed')
    expect(result.content).toBe('Recovered from the malformed call.')
    expect(result.messages.find(({ role }) => role === 'tool')?.content).toContain(
      'incomplete JSON arguments'
    )
    expect(router.execute).not.toHaveBeenCalled()
  })

  it('stops repeated read-only calls that return no new information', async () => {
    let callIndex = 0
    const repeatedRead: AgentKernelProviderSampler = async () => {
      callIndex++
      return {
        result: { ok: true },
        turn: {
          content: '',
          thinking: '',
          thinkingBlocks: [],
          toolCalls: [
            {
              id: `background-${callIndex}`,
              function: { name: 'list_background_tasks', arguments: {} }
            }
          ],
          usage: { promptTokens: 10, completionTokens: 5, doneReason: 'tool_calls' }
        }
      }
    }
    const router = { execute: vi.fn(async () => ({ tasks: [] })) }
    const kernel = new AgentRunKernel(store, undefined, repeatedRead)

    const result = await kernel.start(input(router))

    expect(result.phase).toBe('failed')
    expect(result.error).toContain('identical read-only calls')
    expect(router.execute).toHaveBeenCalledTimes(5)
  })

  it('durably suspends ask_user and resumes only with the human response', async () => {
    const sampler = sequence(
      sampledTurn({
        toolCalls: [
          {
            id: 'question-call',
            function: {
              name: 'ask_user',
              arguments: {
                questions: [{ id: 'format', question: 'Which format?' }]
              }
            }
          }
        ]
      }),
      sampledTurn({ content: 'Using CSV' })
    )
    const kernel = new AgentRunKernel(store, undefined, sampler)
    const running = kernel.start(input())

    await vi.waitFor(() => expect(store.listPendingInteractions('run-1')).toHaveLength(1))
    const interaction = store.listPendingInteractions('run-1')[0]
    expect(store.get('run-1')?.phase).toBe('awaiting_user')
    kernel.resolveInteraction(interaction.id, { format: 'CSV' })

    const result = await running
    expect(result).toMatchObject({ phase: 'completed', content: 'Using CSV' })
    expect(result.messages.find(({ role }) => role === 'tool')?.content).toContain('CSV')
    expect(store.getInteraction(interaction.id)?.status).toBe('resolved')
  })

  it('keeps Plan mode read-only and fails honestly when the planner ignores the contract', async () => {
    let terminalAttempts = 0
    const planController = {
      stage: vi.fn(() => 'planning' as const),
      enter: vi.fn(),
      prepareReview: vi.fn(),
      approve: vi.fn(),
      revise: vi.fn(),
      keep: vi.fn(),
      afterTerminalTurn: vi.fn(async () => {
        terminalAttempts++
        return terminalAttempts <= 2
          ? { continue: true, prompt: 'Present the required structured plan.' }
          : { continue: false, error: 'Planner did not present a contract.' }
      })
    }
    const sampler: AgentKernelProviderSampler = vi.fn(async (request) => {
      const toolNames = (request.tools ?? []).map(({ function: tool }) => tool.name)
      expect(toolNames).toContain('present_plan')
      expect(toolNames).not.toEqual(expect.arrayContaining(['apply_patch', 'shell']))
      return {
        result: { ok: true },
        turn: {
          content: 'Here is an informal plan.',
          thinking: '',
          thinkingBlocks: [],
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 5, doneReason: 'stop' }
        }
      }
    })
    const kernel = new AgentRunKernel(store, undefined, sampler)
    const runInput = input()
    runInput.catalog = {
      surface: 'conversation',
      workspaceRoot: '/workspace',
      planStage: 'planning'
    }
    runInput.profile = agentRunProfile(runInput.catalog)
    runInput.planController = planController

    const result = await kernel.start(runInput)

    expect(result).toMatchObject({ phase: 'failed', error: 'Planner did not present a contract.' })
    expect(sampler).toHaveBeenCalledTimes(3)
    expect(store.listEvents('run-1')).toContainEqual(
      expect.objectContaining({
        type: 'run.retrying',
        payload: expect.objectContaining({ reason: 'plan_contract_required' })
      })
    )
  })

  it('reviews an exact plan revision and switches models and capabilities after approval', async () => {
    const contract = {
      title: 'Update status',
      objective: 'Change the status safely.',
      summary: 'Make one focused change and verify it.',
      requirements: [
        {
          id: 'status-updated',
          outcome: 'Status is updated.',
          acceptance: "src/status.ts exports 'after'."
        }
      ],
      steps: [
        {
          id: 'edit-status',
          title: 'Edit status',
          description: 'Update the export.',
          requirementIds: ['status-updated']
        }
      ],
      verification: [
        {
          id: 'test-status',
          description: 'Run the test.',
          expected: 'The test passes.',
          requirementIds: ['status-updated']
        }
      ]
    }
    let stage: 'planning' | 'executing' = 'planning'
    const planController = {
      stage: vi.fn(() => stage),
      enter: vi.fn(),
      prepareReview: vi.fn(async () => ({
        revision: 'revision-1',
        contract,
        plannerModel: 'planner-model',
        executorModel: 'executor-model'
      })),
      approve: vi.fn(async () => {
        stage = 'executing'
        return {
          profile: agentRunProfile({
            surface: 'conversation',
            workspaceRoot: '/workspace',
            planStage: 'executing'
          }),
          provider: 'openrouter',
          model: 'executor-model',
          request: {
            target: { providerKind: 'openrouter' as const, model: 'executor-model' },
            maxOutputTokens: 2_048,
            purpose: 'conversation' as const
          },
          systemPrompt: 'Approved plan execution instructions.',
          revision: 'revision-1'
        }
      }),
      revise: vi.fn(),
      keep: vi.fn(),
      afterTerminalTurn: vi.fn(async () => ({ continue: false }))
    }
    const requests: ProviderChatRequest[] = []
    const sampler = sequence(
      async (request) => {
        requests.push(request)
        expect(request.target.model).toBe('planner-model')
        expect(
          (request.tools as Array<{ function: { name: string } }>).map(
            ({ function: tool }) => tool.name
          )
        ).toContain('present_plan')
        return sampledTurn({
          toolCalls: [
            {
              id: 'present-plan',
              function: {
                name: 'present_plan',
                arguments: {
                  plan: {
                    ...contract,
                    steps: contract.steps.map(({ requirementIds, ...step }) => ({
                      ...step,
                      requirement_ids: requirementIds
                    })),
                    verification: contract.verification.map(
                      ({ requirementIds, ...verification }) => ({
                        ...verification,
                        requirement_ids: requirementIds
                      })
                    )
                  }
                }
              }
            }
          ]
        })(request, new AbortController().signal, () => undefined)
      },
      async (request) => {
        requests.push(request)
        expect(request.target.model).toBe('executor-model')
        expect(request.messages[0]).toEqual({
          role: 'system',
          content: 'Approved plan execution instructions.'
        })
        expect(
          (request.tools as Array<{ function: { name: string } }>).map(
            ({ function: tool }) => tool.name
          )
        ).toEqual(expect.arrayContaining(['complete_plan', 'apply_patch']))
        return sampledTurn({ content: 'Implemented and verified.' })(
          request,
          new AbortController().signal,
          () => undefined
        )
      }
    )
    const kernel = new AgentRunKernel(store, undefined, sampler)
    const runInput = input()
    runInput.provider = 'litellm'
    runInput.model = 'planner-model'
    runInput.request = {
      target: { providerKind: 'litellm', model: 'planner-model' },
      maxOutputTokens: 1_024,
      purpose: 'conversation'
    }
    runInput.catalog = () => ({
      surface: 'conversation',
      workspaceRoot: '/workspace',
      planStage: stage
    })
    runInput.profile = agentRunProfile({
      surface: 'conversation',
      workspaceRoot: '/workspace',
      planStage: 'planning'
    })
    runInput.planController = planController
    const running = kernel.start(runInput)

    await vi.waitFor(() => expect(store.listPendingInteractions('run-1')).toHaveLength(1))
    const interaction = store.listPendingInteractions('run-1')[0]
    expect(interaction.kind).toBe('plan_approval')
    expect(interaction.request).toMatchObject({ stage: 'review', revision: 'revision-1' })
    kernel.resolveInteraction(interaction.id, { action: 'approve', revision: 'revision-1' })

    const result = await running
    expect(result).toMatchObject({ phase: 'completed', content: 'Implemented and verified.' })
    expect(requests).toHaveLength(2)
    expect(planController.approve).toHaveBeenCalledWith('revision-1')
    expect(store.get('run-1')).toMatchObject({ model: 'executor-model', provider: 'openrouter' })
    expect(store.listEvents('run-1')).toContainEqual(
      expect.objectContaining({
        type: 'plan.mode_changed',
        payload: expect.objectContaining({ from: 'plan', to: 'act', revision: 'revision-1' })
      })
    )
  })

  it('cancels a suspended run and settles its pending interaction', async () => {
    const sampler = sampledTurn({
      toolCalls: [
        {
          id: 'question-call',
          function: { name: 'ask_user', arguments: { questions: [{ id: 'x', question: 'X?' }] } }
        }
      ]
    })
    const kernel = new AgentRunKernel(store, undefined, sampler)
    const running = kernel.start(input())
    await vi.waitFor(() => expect(store.listPendingInteractions('run-1')).toHaveLength(1))

    expect(kernel.stop('run-1')).toBe(true)
    const result = await running
    expect(result.phase).toBe('cancelled')
    expect(store.listPendingInteractions('run-1')).toHaveLength(0)
  })

  it('sends a repaired transcript to the provider', async () => {
    let providerRequest: ProviderChatRequest | undefined
    const sampler: AgentKernelProviderSampler = async (request) => {
      providerRequest = request
      return sampledTurn({ content: 'Recovered' })(
        request,
        new AbortController().signal,
        () => undefined
      )
    }
    const kernel = new AgentRunKernel(store, undefined, sampler)
    const runInput = input()
    runInput.messages = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'dangling', function: { name: 'wait', arguments: { seconds: 1 } } }]
      }
    ]

    await kernel.start(runInput)
    expect(providerRequest?.messages.map(({ role }) => role)).toEqual(['assistant', 'tool'])
    expect(providerRequest?.messages[1].content).toContain('interrupted')
  })

  it('injects external collaboration messages before the next provider step', async () => {
    const requests: ProviderChatRequest[] = []
    const sampler = sequence(
      async (request) => {
        requests.push(request)
        return sampledTurn({
          toolCalls: [{ id: 'wait-1', function: { name: 'wait', arguments: { seconds: 1 } } }]
        })(request, new AbortController().signal, () => undefined)
      },
      async (request) => {
        requests.push(request)
        return sampledTurn({ content: 'Saw the peer update' })(
          request,
          new AbortController().signal,
          () => undefined
        )
      }
    )
    const kernel = new AgentRunKernel(store, undefined, sampler)
    const runInput = input({ execute: vi.fn(async () => ({ ok: true })) })
    let step = 0
    runInput.beforeModelStep = async () => {
      step++
      return step === 2 ? [{ role: 'user', content: 'Peer: API contract is ready.' }] : []
    }

    await kernel.start(runInput)
    expect(requests[1].messages.at(-1)).toEqual({
      role: 'user',
      content: 'Peer: API contract is ready.'
    })
  })

  it('uses one durable permission interaction for sensitive tools', async () => {
    catalog = { surface: 'conversation', workspaceRoot: '/workspace', webSearchEnabled: false }
    const sampler = sequence(
      sampledTurn({
        toolCalls: [
          {
            id: 'write-1',
            function: {
              name: 'apply_patch',
              arguments: {
                patch: '*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch',
                accessLevel: 'confirm'
              }
            }
          }
        ]
      }),
      sampledTurn({ content: 'Permission handled' })
    )
    const router = { execute: vi.fn(async () => ({ ok: true })) }
    const kernel = new AgentRunKernel(store, undefined, sampler)
    const runInput = input(router)
    runInput.permissionMode = 'always-ask'
    const running = kernel.start(runInput)

    await vi.waitFor(() => expect(store.listPendingInteractions('run-1')).toHaveLength(1))
    const interaction = store.listPendingInteractions('run-1')[0]
    expect(interaction.kind).toBe('permission')
    kernel.resolveInteraction(interaction.id, { approved: true })

    expect((await running).phase).toBe('completed')
    expect(router.execute).toHaveBeenCalledOnce()
    expect(store.listEvents('run-1').map(({ type }) => type)).toEqual(
      expect.arrayContaining(['permission.requested', 'permission.resolved'])
    )
  })

  it('runs proven inspection commands without prompting in sensitive-only mode', async () => {
    catalog = { surface: 'conversation', workspaceRoot: '/workspace', webSearchEnabled: false }
    const sampler = sequence(
      sampledTurn({
        toolCalls: [
          {
            id: 'read-1',
            function: { name: 'shell', arguments: { command: 'Get-Content src/app.ts' } }
          }
        ]
      }),
      sampledTurn({ content: 'Inspected' })
    )
    const router = { execute: vi.fn(async () => ({ content: 'source' })) }
    const runInput = input(router)
    runInput.permissionMode = 'sensitive-only'

    expect((await new AgentRunKernel(store, undefined, sampler).start(runInput)).phase).toBe(
      'completed'
    )
    expect(store.listPendingInteractions('run-1')).toHaveLength(0)
    expect(router.execute).toHaveBeenCalledOnce()
  })

  it('forces one compaction and retries after a provider context overflow', async () => {
    const overflow: AgentKernelProviderSampler = vi.fn(async () => ({
      result: {
        ok: false,
        status: 400,
        error:
          "ContextWindowExceededError: This model's maximum context length is 262144 tokens. However, you requested 32000 output tokens and your prompt contains at least 230145 input tokens."
      },
      turn: {
        content: '',
        thinking: '',
        thinkingBlocks: [],
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, doneReason: 'error' }
      }
    }))
    const sampler = sequence(overflow, sampledTurn({ content: 'Recovered after compaction' }))
    const contextManager = {
      shouldCompact: vi.fn(() => false),
      compact: vi.fn(async () => ({
        messages: [{ role: 'user', content: 'Compacted context' }],
        compacted: true,
        details: { strategy: 'test' }
      })),
      observeUsage: vi.fn()
    }
    const kernel = new AgentRunKernel(store, undefined, sampler)

    const result = await kernel.start({ ...input(), contextManager })

    expect(result).toMatchObject({ phase: 'completed', content: 'Recovered after compaction' })
    expect(contextManager.compact).toHaveBeenCalledOnce()
    expect(contextManager.observeUsage).toHaveBeenCalledWith(
      [{ role: 'user', content: 'Compacted context' }],
      expect.any(Array),
      10
    )
    expect(store.listEvents('run-1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'run.retrying',
          payload: expect.objectContaining({
            reason: 'context_window_exceeded',
            contextLength: 262_144,
            requestedOutputTokens: 32_000,
            inputTokens: 230_145
          })
        }),
        expect.objectContaining({
          type: 'compaction.started',
          payload: expect.objectContaining({ reason: 'provider_context_window_exceeded' })
        })
      ])
    )
  })

  it('does not loop when the compacted retry still exceeds provider context', async () => {
    const sampler: AgentKernelProviderSampler = vi.fn(async () => ({
      result: { ok: false, error: 'context_window_exceeded: prompt is too long' },
      turn: {
        content: '',
        thinking: '',
        thinkingBlocks: [],
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, doneReason: 'error' }
      }
    }))
    const contextManager = {
      shouldCompact: vi.fn(() => false),
      compact: vi.fn(async (messages: ProviderChatRequest['messages']) => ({
        messages,
        compacted: true
      }))
    }
    const kernel = new AgentRunKernel(store, undefined, sampler)

    const result = await kernel.start({ ...input(), contextManager })

    expect(result.phase).toBe('failed')
    expect(sampler).toHaveBeenCalledTimes(2)
    expect(contextManager.compact).toHaveBeenCalledOnce()
  })

  it('durably preserves buffered partial output when the provider stream throws', async () => {
    const sampler: AgentKernelProviderSampler = async (_request, _signal, onChunk) => {
      onChunk({ message: { content: 'Partial answer' } })
      throw new Error('socket reset')
    }
    const kernel = new AgentRunKernel(store, undefined, sampler)

    const result = await kernel.start(input())
    const events = store.listEvents('run-1')

    expect(result).toMatchObject({ phase: 'failed', error: 'socket reset' })
    expect(events.map(({ type }) => type)).toEqual([
      'run.started',
      'context.snapshot',
      'run.phase',
      'assistant.delta',
      'run.completed'
    ])
    expect(projectAgentRunEvents(events).content).toBe('Partial answer')
  })

  it('settles cancellation even when a provider ignores AbortSignal and drops late chunks', async () => {
    let releaseProvider!: () => void
    let emitLateChunk!: () => void
    const sampler: AgentKernelProviderSampler = (_request, _signal, onChunk) =>
      new Promise((resolve) => {
        emitLateChunk = () => onChunk({ message: { content: 'ghost output' }, done: true })
        releaseProvider = () =>
          resolve({
            result: { ok: true },
            turn: {
              content: 'ghost output',
              thinking: '',
              thinkingBlocks: [],
              toolCalls: [],
              usage: { promptTokens: 1, completionTokens: 2, doneReason: 'stop' }
            }
          })
      })
    const kernel = new AgentRunKernel(store, undefined, sampler)
    const running = kernel.start(input())

    await vi.waitFor(() => expect(kernel.isActive('run-1')).toBe(true))
    expect(kernel.stop('run-1')).toBe(true)

    await expect(
      Promise.race([running, new Promise((resolve) => setTimeout(resolve, 100))])
    ).resolves.toMatchObject({ phase: 'cancelled' })
    const terminalSequence = store.get('run-1')?.lastSequence

    emitLateChunk()
    releaseProvider()
    await Promise.resolve()

    expect(store.get('run-1')?.lastSequence).toBe(terminalSequence)
    expect(projectAgentRunEvents(store.listEvents('run-1')).content).toBe('')
  })

  it('stops and drains every active run before application shutdown', async () => {
    const sampler: AgentKernelProviderSampler = () => new Promise(() => undefined)
    const kernel = new AgentRunKernel(store, undefined, sampler)
    const first = kernel.start(input())
    const second = kernel.start({ ...input(), id: 'run-2', threadId: 'thread-2' })

    await vi.waitFor(() => expect(kernel.hasActiveRuns()).toBe(true))
    await kernel.stopAll()

    expect(kernel.hasActiveRuns()).toBe(false)
    await expect(first).resolves.toMatchObject({ phase: 'cancelled' })
    await expect(second).resolves.toMatchObject({ phase: 'cancelled' })
  })
})
