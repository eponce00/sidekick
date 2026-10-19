import { describe, expect, it, vi } from 'vitest'
import type { ProviderChatMessage } from '../../shared/providerRuntime'
import { AgentContextManager, type AgentCompactionRecord } from './agentContextManager'

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
})
