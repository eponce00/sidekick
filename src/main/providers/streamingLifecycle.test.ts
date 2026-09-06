import { describe, expect, it, vi } from 'vitest'
import type { ProviderChatRequest, ProviderStreamChunk } from '../../shared/providerRuntime'
import type { ProviderInstance } from '../../shared/settings'
import { streamAnthropicChat } from './anthropicClient'
import { streamOllamaChat } from './ollamaClient'

const request: ProviderChatRequest = {
  target: { providerInstanceId: 'fixture', providerKind: 'anthropic', model: 'fixture' },
  messages: [{ role: 'user', content: 'Synthetic lifecycle test' }],
  purpose: 'conversation'
}
const instance: ProviderInstance = {
  id: 'fixture',
  name: 'Fixture',
  type: 'anthropic',
  enabled: true,
  baseUrl: 'https://fixture.invalid',
  modelSource: 'discover',
  models: []
}
const adapters = [
  {
    name: 'Anthropic',
    stream: streamAnthropicChat,
    text: 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n',
    end: 'data: {"type":"message_stop"}\n'
  },
  {
    name: 'Ollama',
    stream: streamOllamaChat,
    text: '{"message":{"content":"hello"},"done":false}\n',
    end: '{"done":true}\n'
  }
]

function fixture(data: string, closed = true) {
  const cancel = vi.fn()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
        if (data) value.enqueue(new TextEncoder().encode(data))
        if (closed) value.close()
      },
      cancel
    })
  )
  return { response, cancel, controller, fetch: vi.fn(async () => response) as typeof fetch }
}

describe.each(adapters)('$name stream lifecycle', (adapter) => {
  it('stops at the protocol terminal event without waiting for socket EOF', async () => {
    const source = fixture(adapter.text + adapter.end, false)
    const chunks: ProviderStreamChunk[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        adapter.stream(instance, request, (chunk) => chunks.push(chunk), source.fetch),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('still waiting'), 200)
        })
      ])
      expect(result).toMatchObject({ ok: true })
      expect(chunks.filter((chunk) => chunk.done)).toHaveLength(1)
      expect(source.cancel).toHaveBeenCalledTimes(1)
      expect(source.response.body?.locked).toBe(false)
    } finally {
      clearTimeout(timer)
      if (!source.cancel.mock.calls.length) source.controller.close()
    }
  })

  it('does not swallow subscriber failures or emit later buffered records', async () => {
    const source = fixture(adapter.text + adapter.text + adapter.end)
    const emit = vi.fn(() => {
      throw new Error('synthetic observer failure')
    })
    const result = await adapter.stream(instance, request, emit, source.fetch)
    expect(result).toEqual({ ok: false, error: 'synthetic observer failure' })
    expect(emit).toHaveBeenCalledTimes(1)
    expect(source.response.body?.locked).toBe(false)
  })

  it('honors abort from a subscriber before consuming later buffered records', async () => {
    const source = fixture(adapter.text + adapter.text + adapter.end)
    const abort = new AbortController()
    const emit = vi.fn(() => abort.abort())
    const result = await adapter.stream(instance, request, emit, source.fetch, abort.signal)
    expect(result).toEqual({ ok: false, error: 'aborted' })
    expect(emit).toHaveBeenCalledTimes(1)
    expect(source.response.body?.locked).toBe(false)
  })

  it('does not turn truncated transport EOF into successful completion', async () => {
    const source = fixture(adapter.text)
    const chunks: ProviderStreamChunk[] = []
    const result = await adapter.stream(
      instance,
      request,
      (chunk) => chunks.push(chunk),
      source.fetch
    )
    expect(result.ok).toBe(false)
    expect(chunks.some((chunk) => chunk.done && chunk.done_reason !== 'error')).toBe(false)
  })

  it('cancels a pending read even when the fetch fixture does not implement abort', async () => {
    const source = fixture('', false)
    const abort = new AbortController()
    const emit = vi.fn()
    const pending = adapter.stream(instance, request, emit, source.fetch, abort.signal)
    // Let fetch resolve and install the stream abort listener first.
    await Promise.resolve()
    abort.abort()
    expect(await pending).toEqual({ ok: false, error: 'aborted' })
    expect(emit).not.toHaveBeenCalled()
    expect(source.cancel).toHaveBeenCalledTimes(1)
    expect(source.response.body?.locked).toBe(false)
  })

  it('ignores records buffered after terminal completion', async () => {
    const source = fixture(adapter.end + adapter.text)
    const chunks: ProviderStreamChunk[] = []
    expect(
      await adapter.stream(instance, request, (chunk) => chunks.push(chunk), source.fetch)
    ).toMatchObject({ ok: true })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].done).toBe(true)
  })

  it('does not start fetch for an already-aborted request', async () => {
    const source = fixture(adapter.end)
    const abort = new AbortController()
    abort.abort()
    expect(await adapter.stream(instance, request, vi.fn(), source.fetch, abort.signal)).toEqual({
      ok: false,
      error: 'aborted'
    })
    expect(source.fetch).not.toHaveBeenCalled()
  })

  it('preserves cancellation from a terminal subscriber', async () => {
    const source = fixture(adapter.end)
    const abort = new AbortController()
    const result = await adapter.stream(
      instance,
      request,
      () => abort.abort(),
      source.fetch,
      abort.signal
    )
    expect(result).toEqual({ ok: false, error: 'aborted' })
  })
})

describe('Anthropic terminal usage', () => {
  it.each([undefined, 0, 7])('preserves unknown versus explicit usage %s', async (count) => {
    const source = fixture(
      [
        `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: count, output_tokens: 3 } } })}\n`,
        `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: count } })}\n`,
        'data: {"type":"message_stop"}\n'
      ].join('')
    )
    const chunks: ProviderStreamChunk[] = []
    expect(
      await streamAnthropicChat(instance, request, (chunk) => chunks.push(chunk), source.fetch)
    ).toMatchObject({ ok: true })
    expect(chunks.at(-1)?.prompt_eval_count).toBe(count)
    expect(chunks.at(-1)?.eval_count).toBe(count ?? 3)
  })

  it('does not invent zero usage for a response without usage events', async () => {
    const source = fixture('data: {"type":"message_stop"}\n')
    const chunks: ProviderStreamChunk[] = []
    await streamAnthropicChat(instance, request, (chunk) => chunks.push(chunk), source.fetch)
    expect(chunks.at(-1)?.prompt_eval_count).toBeUndefined()
    expect(chunks.at(-1)?.eval_count).toBeUndefined()
  })
})

describe('Anthropic unfinished content blocks', () => {
  it.each([
    [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'c1', name: 'lookup', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"complete-looking"}' }
      }
    ],
    [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'reason', signature: 'partial-signature' }
      }
    ],
    [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'redacted_thinking', data: 'opaque-data' }
      }
    ]
  ])('rejects message_stop without content_block_stop: %j', async (...events) => {
    const source = fixture(
      [...events, { type: 'message_stop' }]
        .map((event) => `data: ${JSON.stringify(event)}\n`)
        .join('')
    )
    const chunks: ProviderStreamChunk[] = []
    const result = await streamAnthropicChat(
      instance,
      request,
      (chunk) => chunks.push(chunk),
      source.fetch
    )
    expect(result).toEqual({
      ok: false,
      error: 'Anthropic stream ended with unfinished content blocks'
    })
    expect(chunks.filter((chunk) => chunk.done)).toEqual([
      {
        done: true,
        done_reason: 'error',
        error: 'Anthropic stream ended with unfinished content blocks'
      }
    ])
    expect(chunks.flatMap((chunk) => chunk.message?.thinking_blocks ?? [])).toEqual([])
  })

  it('preserves finalized tool arguments and signed thinking across unknown future events', async () => {
    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'c1', name: 'lookup', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"exact"}' }
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'future_event', value: 'ignored' },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'thinking', thinking: 'reason', signature: 'prefix' }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'signature_delta', signature: 'suffix' }
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' }
    ]
    const source = fixture(events.map((event) => `data: ${JSON.stringify(event)}\n`).join(''))
    const chunks: ProviderStreamChunk[] = []
    expect(
      await streamAnthropicChat(instance, request, (chunk) => chunks.push(chunk), source.fetch)
    ).toMatchObject({ ok: true })
    expect(
      chunks.flatMap((chunk) => chunk.message?.tool_calls ?? []).at(-1)?.function.arguments
    ).toEqual({ query: 'exact' })
    expect(chunks.flatMap((chunk) => chunk.message?.thinking_blocks ?? [])).toEqual([
      { type: 'thinking', thinking: 'reason', signature: 'prefixsuffix' }
    ])
    expect(chunks.at(-1)).toMatchObject({ done: true, done_reason: 'tool_use' })
    expect(chunks.at(-1)?.prompt_eval_count).toBeUndefined()
  })
})
