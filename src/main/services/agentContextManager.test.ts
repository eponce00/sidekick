import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatCompactionContext } from '../../shared/compactionPrompt'
import { estimateProviderRequestTokens } from '../../shared/contextBudget'
import { formatProjectInstructionsMessage } from '../../shared/projectInstructions'
import type {
  ProviderChatMessage,
  ProviderChatRequest,
  ProviderCompletionResult,
  ProviderStreamChunk
} from '../../shared/providerRuntime'
import { streamProviderChat } from '../providers/providerRuntime'
import {
  AgentContextManager,
  streamSummaryCompletion,
  type AgentCompactionRecord
} from './agentContextManager'

vi.mock('../providers/providerRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/providerRuntime')>()),
  streamProviderChat: vi.fn()
}))

afterEach(() => {
  vi.mocked(streamProviderChat).mockReset()
  vi.useRealTimers()
})

const target = {
  providerKind: 'openai-compatible' as const,
  model: 'test-model',
  contextLength: 8_192
}

function transcript(): ProviderChatMessage[] {
  return [
    { role: 'system', content: 'System policy' },
    ...Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `${index}: ${'historical detail '.repeat(250)}`
    })),
    { role: 'user', content: 'Current request must remain verbatim.' }
  ]
}

describe('AgentContextManager', () => {
  it('budgets across history so later corrections survive large early messages', async () => {
    let serialized = ''
    let record: AgentCompactionRecord | undefined
    const messages: ProviderChatMessage[] = [
      { role: 'system', content: 'Policy' },
      { role: 'user', content: 'Original constraint: never submit.' }
    ]
    for (let index = 0; index < 20; index++)
      messages.push(
        { role: 'user', content: 'archived reference '.repeat(800) },
        {
          role: 'assistant',
          content:
            index === 15 ? 'CORRECTED_REVISION_R23; validation still failed' : 'No new decisions'
        }
      )
    messages.push({ role: 'user', content: 'Continue the current request.' })
    const manager = new AgentContextManager({
      target,
      contextLength: 16384,
      maxOutputTokens: 4096,
      threshold: 0.8,
      enabled: true,
      complete: async (request) => {
        serialized = request.messages[1].content || ''
        return {
          ok: true,
          data: {
            message: { role: 'assistant', content: 'Handoff' },
            promptTokens: 1000,
            completionTokens: 3,
            reasoningTokens: 0,
            finishReason: 'stop'
          }
        }
      },
      onCompacted: (value) => {
        record = value
      }
    })
    await manager.compact(messages, [], new AbortController().signal)
    expect(serialized).toContain('Original constraint: never submit.')
    expect(serialized).toContain('CORRECTED_REVISION_R23; validation still failed')
    expect(serialized.length).toBeLessThan(41100)
    expect(record?.inputTruncated).toBe(true)
    expect(record?.summary).toContain('not complete evidence')
  })

  it('cuts the latest turn’s oversized tool results when they alone outgrow the window', async () => {
    // Seven file reads at once on a 24k window ended the run with "did not reduce context".
    const complete = vi.fn()
    const manager = new AgentContextManager({
      target,
      contextLength: 24_576,
      maxOutputTokens: 4_096,
      threshold: 0.65,
      enabled: true,
      complete
    })
    const reads = Array.from({ length: 6 }, (_, index) => `read-${index}`)
    const messages: ProviderChatMessage[] = [
      { role: 'system', content: 'Policy' },
      { role: 'user', content: 'Read every module and name its last function.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: reads.map((id) => ({
          id,
          function: { name: 'read', arguments: { path: `${id}.js` } }
        }))
      },
      ...reads.map((id) => ({
        role: 'tool',
        tool_call_id: id,
        content: `opening of ${id}\n${'function step(entry) { return entry }\n'.repeat(700)}last function of ${id}`
      }))
    ]

    const result = await manager.compact(messages, [], new AbortController().signal)

    expect(result.compacted).toBe(true)
    expect(complete).not.toHaveBeenCalled()
    expect(estimateProviderRequestTokens(result.messages, [])).toBeLessThan(24_576 - 4_096)
    const results = result.messages.filter((message) => message.role === 'tool')
    expect(results.map((message) => message.tool_call_id)).toEqual(reads)
    for (const [index, message] of results.entries()) {
      expect(message.content).toContain(`opening of read-${index}`)
      expect(message.content).toContain(`last function of read-${index}`)
      expect(message.content).toContain('SideKick cut')
    }
  })

  it('does not treat a truncated summary or fallback excerpts as verified completion', async () => {
    let record: AgentCompactionRecord | undefined
    const manager = new AgentContextManager({
      target,
      contextLength: 8192,
      maxOutputTokens: 2048,
      threshold: 0.8,
      enabled: true,
      complete: async () => ({
        ok: true,
        data: {
          message: { role: 'assistant', content: 'TRUNCATED_CLAIM_OF_SUCCESS' },
          promptTokens: 1000,
          completionTokens: 2048,
          reasoningTokens: 0,
          finishReason: 'length'
        }
      }),
      onCompacted: (value) => {
        record = value
      }
    })
    await manager.compact(transcript(), [], new AbortController().signal)
    expect(record?.strategy).toBe('deterministic')
    expect(record?.summary).not.toContain('TRUNCATED_CLAIM_OF_SUCCESS')
    expect(record?.summary).toContain('not verification of completion')
    expect(record?.summary).toContain('actual tool state before retrying')
  })
  it('compacts old context while retaining system and recent user messages', async () => {
    let record: AgentCompactionRecord | null = null
    const complete = vi.fn(async () => ({
      ok: true,
      data: {
        message: { role: 'assistant', content: 'Objective and verified work summary.' },
        promptTokens: 1_000,
        completionTokens: 20,
        reasoningTokens: 0,
        finishReason: 'stop'
      }
    }))
    const manager = new AgentContextManager({
      target,
      contextLength: 8_192,
      maxOutputTokens: 2_048,
      threshold: 0.8,
      enabled: true,
      complete,
      onCompacted: (value) => {
        record = value
      }
    })

    expect(manager.shouldCompact(transcript(), [])).toBe(true)
    const result = await manager.compact(transcript(), [], new AbortController().signal)

    expect(result.compacted).toBe(true)
    expect(result.messages[0]).toEqual({ role: 'system', content: 'System policy' })
    expect(result.messages.some(({ content }) => content?.includes('Objective and verified'))).toBe(
      true
    )
    expect(result.messages.at(-1)?.content).toBe('Current request must remain verbatim.')
    expect(record).toMatchObject({ strategy: 'model', promptVersion: expect.any(String) })
  })

  it('records deterministic fallback provenance when summarization fails', async () => {
    let record: AgentCompactionRecord | null = null
    const manager = new AgentContextManager({
      target,
      contextLength: 8_192,
      maxOutputTokens: 2_048,
      threshold: 0.8,
      enabled: true,
      complete: async () => ({ ok: false, error: 'provider unavailable' }),
      onCompacted: (value) => {
        record = value
      }
    })

    await manager.compact(transcript(), [], new AbortController().signal)
    expect(record).toMatchObject({ strategy: 'deterministic', provider: 'openai-compatible' })
  })

  it('compacts a fresh user turn after many complete tool exchanges', async () => {
    const messages: ProviderChatMessage[] = [
      { role: 'system', content: 'System policy' },
      { role: 'user', content: 'Build a Cuba demographics dashboard.' }
    ]
    for (let index = 0; index < 8; index++) {
      const id = `call-${index}`
      messages.push({
        role: 'assistant',
        content: `Research batch ${index}`,
        tool_calls: [
          { id, function: { name: 'web_fetch', arguments: { url: `https://x/${index}` } } }
        ]
      })
      messages.push({
        role: 'tool',
        tool_call_id: id,
        content: `Source ${index}: ${'demographic evidence '.repeat(700)}`
      })
    }
    const manager = new AgentContextManager({
      target: { ...target, contextLength: 32_768 },
      contextLength: 32_768,
      maxOutputTokens: 8_192,
      threshold: 0.8,
      enabled: true,
      complete: async () => ({
        ok: true,
        data: {
          message: {
            role: 'assistant',
            content: 'Continue building the Cuba demographics dashboard from verified research.'
          },
          promptTokens: 10_000,
          completionTokens: 20,
          reasoningTokens: 0,
          finishReason: 'stop'
        }
      })
    })

    expect(manager.shouldCompact(messages, [])).toBe(true)
    const result = await manager.compact(messages, [], new AbortController().signal)

    expect(result.compacted).toBe(true)
    expect(result.messages[0].role).toBe('system')
    expect(result.messages[1].content).toContain('Cuba demographics dashboard')
    expect(result.messages[2]?.role).not.toBe('tool')
    expect(result.details?.messagesCompacted).toBeGreaterThan(1)
  })

  it('keeps the request a long run answers word for word, not an earlier question', async () => {
    const messages: ProviderChatMessage[] = [
      { role: 'system', content: 'System policy' },
      { role: 'user', content: 'Can you clone the private repository for me?' },
      { role: 'assistant', content: 'I cannot reach it; clone it and I will read the files.' },
      { role: 'user', content: 'So what is done and what is pending?' }
    ]
    for (let index = 0; index < 8; index++) {
      const id = `call-${index}`
      messages.push(
        {
          role: 'assistant',
          content: `Checking ${index}`,
          tool_calls: [
            { id, function: { name: 'shell', arguments: { command: `check ${index}` } } }
          ]
        },
        { role: 'tool', tool_call_id: id, content: `Result ${index}: ${'log line '.repeat(900)}` }
      )
      if (index === 5) {
        messages.push({
          role: 'user',
          content:
            '<sidekick_verification_guard trust="app-policy">\nVerify.\n</sidekick_verification_guard>'
        })
      }
    }
    const manager = new AgentContextManager({
      target: { ...target, contextLength: 32_768 },
      contextLength: 32_768,
      maxOutputTokens: 8_192,
      threshold: 0.8,
      enabled: true,
      // The summary a local model wrote: the earlier question as the objective.
      complete: async () => ({
        ok: true,
        data: {
          message: { role: 'assistant', content: '## Objective\n- Clone the private repository.' },
          promptTokens: 10_000,
          completionTokens: 20,
          reasoningTokens: 0,
          finishReason: 'stop'
        }
      })
    })

    const result = await manager.compact(messages, [], new AbortController().signal)
    expect(result.compacted).toBe(true)
    const kept = result.messages.filter(
      (message) => message.content === 'So what is done and what is pending?'
    )
    expect(kept).toHaveLength(1)
    const summaryAt = result.messages.findIndex((message) =>
      message.content?.startsWith('<historical_context')
    )
    expect(result.messages[summaryAt + 1].content).toBe('So what is done and what is pending?')
    expect(
      result.messages.some(
        (message) => message.content === 'Can you clone the private repository for me?'
      )
    ).toBe(false)
  })

  it('uses actual provider prompt usage to correct future preflight estimates', () => {
    const manager = new AgentContextManager({
      target,
      contextLength: 8_192,
      maxOutputTokens: 2_048,
      threshold: 0.8,
      enabled: true
    })
    const initial = [{ role: 'user', content: 'A short request' }] satisfies ProviderChatMessage[]
    manager.observeUsage(initial, [], 4_400)

    expect(manager.shouldCompact(initial, [])).toBe(false)
    expect(
      manager.shouldCompact(
        [
          ...initial,
          { role: 'assistant', content: 'Continue' },
          { role: 'tool', content: 'x'.repeat(8_000) }
        ],
        []
      )
    ).toBe(true)
  })

  it('starts a new run with the provider calibration learned by the previous turn', () => {
    const manager = new AgentContextManager({
      target,
      contextLength: 8_192,
      maxOutputTokens: 2_048,
      threshold: 0.8,
      enabled: true,
      initialEstimationBiasTokens: 6_000
    })

    expect(manager.shouldCompact([{ role: 'user', content: 'Continue' }], [])).toBe(true)
  })

  it('allows long runs to compact again after successful provider samples', async () => {
    const complete = vi.fn(async () => ({
      ok: true,
      data: {
        message: { role: 'assistant', content: 'Short durable summary.' },
        promptTokens: 1_000,
        completionTokens: 20,
        reasoningTokens: 0,
        finishReason: 'stop'
      }
    }))
    const manager = new AgentContextManager({
      target,
      contextLength: 8_192,
      maxOutputTokens: 2_048,
      threshold: 0.8,
      enabled: true,
      complete
    })

    for (let index = 0; index < 5; index++) {
      expect(
        (await manager.compact(transcript(), [], new AbortController().signal)).compacted
      ).toBe(true)
      manager.observeUsage([{ role: 'user', content: `Successful sample ${index}` }], [], 1_000)
    }

    expect(complete).toHaveBeenCalledTimes(5)
  })

  it('cuts a reply limit to the room left near the end of the window', () => {
    const manager = new AgentContextManager({
      target,
      contextLength: 8_192,
      maxOutputTokens: 4_096,
      threshold: 0.8,
      enabled: true
    })
    const short = [{ role: 'user', content: 'A short request' }] satisfies ProviderChatMessage[]
    const long = [{ role: 'user', content: 'word '.repeat(6_000) }] satisfies ProviderChatMessage[]

    expect(manager.replyLimit(short, [], 4_096)).toBe(4_096)
    expect(manager.replyLimit(long, [], 4_096)).toBeLessThan(4_096)
    expect(manager.replyLimit(long, [], 4_096)).toBeGreaterThanOrEqual(1_024)
    expect(manager.replyLimit(short, [], undefined)).toBeUndefined()
  })

  it('keeps the recent work of a large window, and gives the summary room to think', async () => {
    let summaryLimit: number | undefined
    const manager = new AgentContextManager({
      target: { ...target, contextLength: 260_000 },
      contextLength: 260_000,
      maxOutputTokens: 100_000,
      threshold: 0.8,
      enabled: true,
      complete: async (request) => {
        summaryLimit = request.maxOutputTokens
        return {
          ok: true,
          data: {
            message: { role: 'assistant', content: 'Handoff' },
            promptTokens: 1000,
            completionTokens: 3,
            reasoningTokens: 0,
            finishReason: 'stop'
          }
        }
      }
    })
    const messages: ProviderChatMessage[] = [{ role: 'system', content: 'Policy' }]
    for (let index = 0; index < 60; index++) {
      messages.push(
        { role: 'user', content: `step ${index} ${'detail '.repeat(1_500)}` },
        { role: 'assistant', content: `done ${index}` }
      )
    }

    const result = await manager.compact(messages, [], new AbortController().signal)
    const kept = result.messages.filter((message) => message.content?.startsWith('step '))

    // About 32k tokens of recent steps stay word for word, not the 8k kept before.
    expect(kept.length).toBeGreaterThanOrEqual(8)
    expect(kept.length).toBeLessThan(20)
    expect(summaryLimit).toBe(16_384)
  })
  it.each<[string, ProviderCompletionResult, Record<string, unknown>]>([
    [
      "Node's five-minute limit",
      {
        ok: false,
        error:
          'The model server at 127.0.0.1:8080 took the request but sent no reply for 5 minutes, so SideKick stopped waiting. (UND_ERR_HEADERS_TIMEOUT)'
      },
      { fallbackReason: 'timeout' }
    ],
    [
      'a gateway that gave up',
      { ok: false, error: 'HTTP 504', status: 504 },
      { fallbackReason: 'timeout', fallbackStatus: 504 }
    ],
    [
      'a dropped connection',
      {
        ok: false,
        error:
          'Lost the connection to the model server at 127.0.0.1:8080 while it was replying; the server stopped or restarted. (UND_ERR_SOCKET)'
      },
      { fallbackReason: 'connection_lost' }
    ],
    [
      'a request over the window',
      {
        ok: false,
        error:
          "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.",
        status: 400
      },
      { fallbackReason: 'context_overflow', fallbackStatus: 400 }
    ],
    [
      'any other refusal',
      { ok: false, error: 'HTTP 500', status: 500 },
      { fallbackReason: 'provider_error', fallbackStatus: 500 }
    ],
    [
      'a summary cut off by its limit',
      {
        ok: true,
        data: {
          message: { role: 'assistant', content: 'Half a summ' },
          promptTokens: 1_000,
          completionTokens: 2_048,
          reasoningTokens: 0,
          finishReason: 'length'
        }
      },
      { fallbackReason: 'output_limit' }
    ],
    [
      'a model that only reasoned',
      {
        ok: true,
        data: {
          message: { role: 'assistant', content: '', thinking: 'Let me think about the notes.' },
          promptTokens: 1_000,
          completionTokens: 900,
          reasoningTokens: 0,
          finishReason: 'stop'
        }
      },
      { fallbackReason: 'reasoning_only' }
    ],
    [
      'an empty reply',
      {
        ok: true,
        data: {
          message: { role: 'assistant', content: '   ' },
          promptTokens: 1_000,
          completionTokens: 1,
          reasoningTokens: 0,
          finishReason: 'stop'
        }
      },
      { fallbackReason: 'empty_output' }
    ]
  ])(
    'records why it used the fallback summary after %s, without content',
    async (_, result, expected) => {
      let record: AgentCompactionRecord | undefined
      const manager = new AgentContextManager({
        target,
        contextLength: 8_192,
        maxOutputTokens: 2_048,
        threshold: 0.8,
        enabled: true,
        complete: async () => result,
        onCompacted: (value) => {
          record = value
        }
      })
      const compacted = await manager.compact(transcript(), [], new AbortController().signal)
      expect(compacted.details).toMatchObject({ strategy: 'deterministic', ...expected })
      if (!('fallbackStatus' in expected))
        expect(compacted.details).not.toHaveProperty('fallbackStatus')
      expect(record?.fallbackReason).toBe(expected.fallbackReason)
    }
  )

  it('keeps the project instructions word for word, and folds the earlier summary in', async () => {
    const instructions = formatProjectInstructionsMessage({
      content: 'PROJECT-RULE: run the tests before shipping.',
      sources: ['AGENTS.md']
    })
    let request: ProviderChatRequest | undefined
    const manager = new AgentContextManager({
      target,
      contextLength: 8_192,
      maxOutputTokens: 2_048,
      threshold: 0.8,
      enabled: true,
      complete: async (value) => {
        request = value
        return {
          ok: true,
          data: {
            message: { role: 'assistant', content: 'NEW-SUMMARY of the run.' },
            promptTokens: 1_000,
            completionTokens: 5,
            reasoningTokens: 0,
            finishReason: 'stop'
          }
        }
      }
    })
    const [system, ...rest] = transcript()
    const messages: ProviderChatMessage[] = [
      system,
      { role: 'user', content: instructions },
      { role: 'user', content: formatCompactionContext('OLD-SUMMARY of earlier work.') },
      ...rest
    ]

    const result = await manager.compact(messages, [], new AbortController().signal)

    // In the order the next run's preparer sends them: instructions, then the summary.
    expect(result.messages.slice(0, 2)).toEqual([system, { role: 'user', content: instructions }])
    expect(result.messages[2].content).toContain(
      formatCompactionContext('NEW-SUMMARY of the run.').split('\n</historical_context>')[0]
    )
    expect(result.messages.filter((message) => message.content?.includes('SUMMARY'))).toHaveLength(
      1
    )
    const sent = request!.messages[1].content!
    expect(sent).not.toContain('PROJECT-RULE')
    expect(sent).toContain('OLD-SUMMARY of earlier work.')
  })

  it('records no fallback reason for a model summary', async () => {
    const manager = new AgentContextManager({
      target,
      contextLength: 8_192,
      maxOutputTokens: 2_048,
      threshold: 0.8,
      enabled: true,
      complete: async () => ({
        ok: true,
        data: {
          message: { role: 'assistant', content: 'Summary.' },
          promptTokens: 1_500,
          completionTokens: 3,
          reasoningTokens: 0,
          finishReason: 'stop'
        }
      })
    })
    const compacted = await manager.compact(transcript(), [], new AbortController().signal)
    expect(compacted.details).toMatchObject({ strategy: 'model', summaryPromptTokens: 1_500 })
    expect(compacted.details).not.toHaveProperty('fallbackReason')
  })

  it('is no compaction at all when the run is stopped while the summary is written', async () => {
    // Recording the deterministic stand-in as a finished compaction kept it, and a later run
    // started from the lossy excerpts.
    const controller = new AbortController()
    const onCompacted = vi.fn()
    const manager = new AgentContextManager({
      target,
      contextLength: 8_192,
      maxOutputTokens: 2_048,
      threshold: 0.8,
      enabled: true,
      complete: async () => {
        controller.abort()
        return { ok: false, error: 'aborted' }
      },
      onCompacted
    })
    await expect(manager.compact(transcript(), [], controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(onCompacted).not.toHaveBeenCalled()
  })

  it('asks for a summary that fits the window with its reply, even from JSON-heavy history', async () => {
    let request: ProviderChatRequest | undefined
    const messages: ProviderChatMessage[] = [{ role: 'system', content: 'Policy' }]
    for (let index = 0; index < 30; index++) {
      const id = `call-${index}`
      messages.push(
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, function: { name: 'read', arguments: { path: `src/${index}.json` } } }]
        },
        {
          role: 'tool',
          tool_call_id: id,
          content: JSON.stringify(
            Array.from({ length: 400 }, (_, item) => ({ id: item, v: [1, 2] }))
          )
        }
      )
    }
    messages.push({ role: 'user', content: 'Continue.' })
    const manager = new AgentContextManager({
      target: { ...target, contextLength: 32_768 },
      contextLength: 32_768,
      maxOutputTokens: 8_192,
      threshold: 0.8,
      enabled: true,
      previousSummary: 'An earlier summary. '.repeat(200),
      complete: async (value) => {
        request = value
        return {
          ok: true,
          data: {
            message: { role: 'assistant', content: 'Summary.' },
            promptTokens: 1,
            completionTokens: 1,
            reasoningTokens: 0,
            finishReason: 'stop'
          }
        }
      }
    })
    await manager.compact(messages, [], new AbortController().signal)
    // Sized at four characters a token, as before, this request ran past the window.
    expect(
      estimateProviderRequestTokens(request!.messages, []) + request!.maxOutputTokens!
    ).toBeLessThanOrEqual(32_768)
  })

  it('lowers its estimate to the real count, so a chat it overestimates is not compacted early', () => {
    const manager = new AgentContextManager({
      target: { ...target, contextLength: 32_768 },
      contextLength: 32_768,
      maxOutputTokens: 4_096,
      threshold: 0.8,
      enabled: true
    })
    const messages = [
      { role: 'user', content: '{"key": [1, 2, 3]}, '.repeat(1_900) }
    ] satisfies ProviderChatMessage[]
    expect(manager.shouldCompact(messages, [])).toBe(true)
    const estimated = manager.observeUsage(messages, [], 20_000)
    expect(estimated).toBeGreaterThan(26_000)
    expect(manager.shouldCompact(messages, [])).toBe(false)
    // What is added later still counts at the full estimate.
    expect(
      manager.shouldCompact([...messages, { role: 'tool', content: 'x'.repeat(30_000) }], [])
    ).toBe(true)
  })

  it('starts below its own estimate when an earlier run found the estimate high', () => {
    const options = {
      target,
      contextLength: 8_192,
      maxOutputTokens: 2_048,
      threshold: 0.8,
      enabled: true
    }
    const messages = [
      { role: 'user', content: 'word, '.repeat(3_000) }
    ] satisfies ProviderChatMessage[]
    expect(new AgentContextManager(options).shouldCompact(messages, [])).toBe(true)
    expect(
      new AgentContextManager({ ...options, initialEstimationBiasTokens: -1_500 }).shouldCompact(
        messages,
        []
      )
    ).toBe(false)
  })
})

describe('streamSummaryCompletion', () => {
  const request = {
    target,
    purpose: 'compaction' as const,
    messages: [{ role: 'user' as const, content: 'Summarize.' }]
  }

  it('collects the streamed summary, its reasoning, and the provider counts', async () => {
    vi.mocked(streamProviderChat).mockImplementation(async (_request, emit) => {
      emit({ message: { thinking: 'Reading the notes.' } } as ProviderStreamChunk)
      emit({ message: { content: 'Summary ' } })
      emit({ message: { content: 'of the notes.' } })
      emit({ done: true, done_reason: 'stop', prompt_eval_count: 12_000, eval_count: 40 })
      return { ok: true }
    })
    await expect(streamSummaryCompletion(request)).resolves.toEqual({
      ok: true,
      data: {
        message: {
          role: 'assistant',
          content: 'Summary of the notes.',
          thinking: 'Reading the notes.'
        },
        promptTokens: 12_000,
        completionTokens: 40,
        reasoningTokens: 0,
        finishReason: 'stop'
      }
    })
  })

  it('gives up only after the model makes no progress for the idle limit', async () => {
    vi.useFakeTimers()
    vi.mocked(streamProviderChat).mockImplementation(
      async (_request, emit, signal) =>
        new Promise((resolve) => {
          // Progress every 50 seconds for over three minutes, then silence.
          let sent = 0
          const tick = setInterval(() => {
            if (sent++ < 4) emit({ message: { content: '.' } })
          }, 50_000)
          signal?.addEventListener('abort', () => {
            clearInterval(tick)
            resolve({ ok: false, error: 'aborted' })
          })
        })
    )
    let settled = false
    const result = streamSummaryCompletion(request, undefined, 60_000).finally(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(250_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    const value = await result
    expect(value.ok).toBe(false)
    expect(value.error).toContain('so SideKick stopped waiting')
  })

  it('reports a run stopped by the user as aborted, not as a timeout', async () => {
    const controller = new AbortController()
    vi.mocked(streamProviderChat).mockImplementation(async () => {
      controller.abort()
      return { ok: false, error: 'aborted' }
    })
    await expect(streamSummaryCompletion(request, controller.signal)).resolves.toEqual({
      ok: false,
      error: 'aborted'
    })
  })
})
