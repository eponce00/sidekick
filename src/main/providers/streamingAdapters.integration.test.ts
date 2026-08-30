import { describe, expect, it, vi } from 'vitest'
import type { ProviderChatRequest, ProviderStreamChunk } from '../../shared/providerRuntime'
import type { ProviderInstance } from '../../shared/settings'
import { streamOpenAICompatibleChat } from './openAIStreamingClient'
import { completeAnthropicChat, streamAnthropicChat, toAnthropicMessages } from './anthropicClient'
import { streamOllamaChat, toOllamaMessages } from './ollamaClient'
import { toOpenAICompatibleMessages } from './providerRuntime'
import { readIncompleteToolInputError } from '../../shared/toolCalls'

function streamingResponse(chunks: string[], init: ResponseInit = { status: 200 }): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    }),
    init
  )
}

const request: ProviderChatRequest = {
  target: {
    providerInstanceId: 'fixture',
    providerKind: 'openai-compatible',
    model: 'fixture-model',
    contextLength: 32_768
  },
  messages: [{ role: 'user', content: 'Use the lookup tool.' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'lookup',
        description: 'Look up a value',
        parameters: { type: 'object', properties: { query: { type: 'string' } } }
      }
    }
  ],
  maxOutputTokens: 4_096,
  thinkingEnabled: true,
  purpose: 'conversation'
}

function text(chunks: ProviderStreamChunk[], key: 'content' | 'thinking'): string {
  return chunks.map((chunk) => chunk.message?.[key] || '').join('')
}

describe('provider streaming adapters', () => {
  it('normalizes fragmented OpenAI SSE reasoning, think tags, tools, usage, and ids', async () => {
    const response = streamingResponse([
      'data: {"id":"gen-1","choices":[{"delta":{"reasoning_content":"reason "}}]}\n',
      'data: {"choices":[{"delta":{"content":"<thi"}}]}\n',
      'data: {"choices":[{"delta":{"content":"nk>plan</th"}}]}\n',
      'data: {"choices":[{"delta":{"content":"ink>Answer"}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"lookup","arguments":"{\\"query\\":"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"cuba\\"}"}}]},"finish_reason":"tool_calls"}]}\n',
      'data: {"choices":[],"usage":{"prompt_tokens":21,"completion_tokens":8,"prompt_tokens_details":{"cached_tokens":13}}}\n',
      'data: [DONE]\n'
    ])
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch
    const chunks: ProviderStreamChunk[] = []
    const result = await streamOpenAICompatibleChat(
      'https://provider.test/v1',
      { model: 'fixture-model', messages: request.messages },
      { Authorization: 'Bearer hidden' },
      (chunk) => chunks.push(chunk),
      fetchImpl
    )

    expect(result).toEqual({ ok: true, generationId: 'gen-1' })
    expect(text(chunks, 'thinking')).toBe('reason plan')
    expect(text(chunks, 'content')).toBe('Answer')
    const streamedCalls = chunks.flatMap((chunk) => chunk.message?.tool_calls || [])
    expect(streamedCalls[0]).toMatchObject({
      id: 'call-1',
      function: { name: 'lookup', arguments: {} }
    })
    expect(streamedCalls.at(-1)).toMatchObject({
      id: 'call-1',
      function: { name: 'lookup', arguments: '{"query":"cuba"}' }
    })
    expect(chunks.at(-1)).toMatchObject({
      done: true,
      done_reason: 'tool_calls',
      prompt_eval_count: 21,
      cached_prompt_tokens: 13,
      eval_count: 8
    })
  })

  it('returns retry metadata for an OpenAI-compatible HTTP failure', async () => {
    const fetchImpl = vi.fn(async () =>
      streamingResponse(['{"error":{"message":"slow down"}}'], {
        status: 429,
        headers: { 'Retry-After': '7', 'Content-Type': 'application/json' }
      })
    ) as unknown as typeof fetch
    const result = await streamOpenAICompatibleChat(
      'https://provider.test/v1',
      {},
      {},
      vi.fn(),
      fetchImpl
    )
    expect(result).toEqual({ ok: false, error: 'slow down', status: 429, retryAfter: 7 })
  })

  it('turns a truncated streamed tool payload into a safe recoverable tool result', async () => {
    const response = streamingResponse([
      'data: {"id":"gen-broken","choices":[{"delta":{"tool_calls":[{"index":0,"id":"write-1","type":"function","function":{"name":"write","arguments":"{\\"file_path\\":\\"src/app.ts\\",\\"content\\":\\"export"}}]}}]}\n',
      'data: {"error":{"message":"Unterminated string starting at: line 1 column 93"}}\n'
    ])
    const chunks: ProviderStreamChunk[] = []
    const result = await streamOpenAICompatibleChat(
      'https://provider.test/v1',
      { model: 'fixture-model', messages: request.messages, tools: request.tools },
      {},
      (chunk) => chunks.push(chunk),
      vi.fn(async () => response) as unknown as typeof fetch
    )

    expect(result).toEqual({ ok: true, generationId: 'gen-broken' })
    const recovered = chunks.flatMap((chunk) => chunk.message?.tool_calls || []).at(-1)
    expect(recovered).toMatchObject({
      id: 'write-1',
      function: { name: 'write' }
    })
    expect(readIncompleteToolInputError(recovered?.function.arguments)).toContain(
      'tool was not executed'
    )
    expect(chunks.at(-1)).toMatchObject({ done: true, done_reason: 'tool_calls' })
  })

  it('recovers tool calls from a non-streaming response when a local stream is empty', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        streamingResponse([
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
          'data: [DONE]\n'
        ])
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'recovered-1',
                      type: 'function',
                      function: { name: 'lookup', arguments: '{"query":"cuba"}' }
                    }
                  ]
                }
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 3 }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      ) as unknown as typeof fetch
    const chunks: ProviderStreamChunk[] = []
    const result = await streamOpenAICompatibleChat(
      'http://localhost:1234/v1',
      { model: 'local', messages: request.messages, tools: request.tools },
      {},
      (chunk) => chunks.push(chunk),
      fetchImpl
    )

    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(chunks.flatMap((chunk) => chunk.message?.tool_calls || [])[0]).toMatchObject({
      id: 'recovered-1',
      function: { name: 'lookup', arguments: '{"query":"cuba"}' }
    })
    expect(chunks.at(-1)).toMatchObject({
      done: true,
      done_reason: 'tool_calls',
      prompt_eval_count: 10,
      eval_count: 3
    })
  })

  it('returns the fallback failure when an OpenAI-compatible tool stream is empty', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(streamingResponse(['data: [DONE]\n']))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'model rejected tools' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
      ) as unknown as typeof fetch

    const result = await streamOpenAICompatibleChat(
      'http://localhost:1234/v1',
      { model: 'local', messages: request.messages, tools: request.tools },
      {},
      vi.fn(),
      fetchImpl
    )

    expect(result).toMatchObject({ ok: false, status: 400, error: 'model rejected tools' })
  })

  it('converts images and structured tool calls to OpenAI-compatible message content', () => {
    const converted = toOpenAICompatibleMessages([
      { role: 'user', content: 'Inspect', images: ['data:image/png;base64,AAAA'] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: { query: 'cuba' } } }]
      },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1' }
    ])

    expect(converted[0].content).toEqual([
      { type: 'text', text: 'Inspect' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    ])
    expect(converted[1]).toMatchObject({
      tool_calls: [{ function: { name: 'lookup', arguments: '{"query":"cuba"}' } }]
    })
    expect(converted[2]).toMatchObject({ tool_call_id: 'call-1' })
  })

  it('keeps OpenAI tool results contiguous before a linked multimodal observation', () => {
    const converted = toOpenAICompatibleMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-1', function: { name: 'observe', arguments: {} } },
          { id: 'call-2', function: { name: 'read', arguments: {} } }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: 'Captured viewport.',
        media: [
          {
            type: 'image',
            mimeType: 'image/png',
            name: 'viewport.png',
            source: { type: 'data_url', dataUrl: 'data:image/png;base64,AAAA' }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'call-2', content: 'read output' },
      { role: 'assistant', content: 'continuing' }
    ])

    expect(converted.map(({ role }) => role)).toEqual([
      'assistant',
      'tool',
      'tool',
      'user',
      'assistant'
    ])
    expect(converted[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'Captured viewport.'
    })
    expect(converted[3].content).toEqual([
      { type: 'text', text: 'Visual output from tool call call-1:' },
      { type: 'text', text: 'viewport.png' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    ])
  })

  it('normalizes Anthropic thinking, text, partial tool JSON, and cumulative usage', async () => {
    const events = [
      {
        type: 'message_start',
        message: { id: 'msg-1', usage: { input_tokens: 30, output_tokens: 1 } }
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'plan' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'signed' }
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking.' } },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"query":' }
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '"cuba"}' }
      },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' }
    ]
    const response = streamingResponse([
      events
        .slice(0, 5)
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(''),
      events
        .slice(5)
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join('')
    ])
    let postedBody: Record<string, unknown> | undefined
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return response
    }) as unknown as typeof fetch
    const instance: ProviderInstance = {
      id: 'anthropic',
      name: 'Anthropic',
      type: 'anthropic',
      enabled: true,
      baseUrl: 'https://api.anthropic.test/v1',
      apiKey: 'hidden',
      modelSource: 'discover',
      models: []
    }
    const chunks: ProviderStreamChunk[] = []
    const result = await streamAnthropicChat(
      instance,
      { ...request, target: { ...request.target, providerKind: 'anthropic' } },
      (chunk) => chunks.push(chunk),
      fetchImpl
    )

    expect(result).toEqual({ ok: true, generationId: 'msg-1' })
    expect(postedBody).toMatchObject({ stream: true, thinking: expect.any(Object) })
    expect(text(chunks, 'thinking')).toBe('plan')
    expect(chunks.flatMap((chunk) => chunk.message?.thinking_blocks || [])).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'signed' }
    ])
    expect(text(chunks, 'content')).toBe('Checking.')
    const streamedCalls = chunks.flatMap((chunk) => chunk.message?.tool_calls || [])
    expect(streamedCalls[0]).toMatchObject({
      id: 'tool-1',
      function: { name: 'lookup', arguments: {} }
    })
    expect(streamedCalls.at(-1)).toMatchObject({
      id: 'tool-1',
      function: { name: 'lookup', arguments: { query: 'cuba' } }
    })
    expect(chunks.at(-1)).toMatchObject({
      done: true,
      done_reason: 'tool_use',
      prompt_eval_count: 30,
      eval_count: 12
    })
  })

  it('converts OpenAI-style system, image, tool-use, and tool-result messages for Anthropic', () => {
    const converted = toAnthropicMessages([
      { role: 'system', content: 'System policy' },
      { role: 'user', content: 'Look', images: ['data:image/png;base64,AAAA'] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tool-1', function: { name: 'lookup', arguments: { query: 'cuba' } } }]
      },
      {
        role: 'tool',
        tool_call_id: 'tool-1',
        content: '{"value":1}',
        media: [
          {
            type: 'image',
            mimeType: 'image/png',
            source: { type: 'data_url', dataUrl: 'data:image/png;base64,AAAA' }
          }
        ]
      }
    ])
    expect(converted.system).toBe('System policy')
    expect(converted.messages[0].content).toContainEqual(expect.objectContaining({ type: 'image' }))
    expect(converted.messages[1].content).toContainEqual(
      expect.objectContaining({ type: 'tool_use', id: 'tool-1' })
    )
    expect(converted.messages[2].content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: expect.arrayContaining([expect.objectContaining({ type: 'image' })])
      })
    ])
  })

  it('preserves signed and redacted thinking blocks in Anthropic completions', async () => {
    const instance: ProviderInstance = {
      id: 'anthropic',
      name: 'Anthropic',
      type: 'anthropic',
      enabled: true,
      baseUrl: 'https://api.anthropic.test/v1',
      apiKey: 'hidden',
      modelSource: 'discover',
      models: []
    }
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              { type: 'thinking', thinking: 'plan', signature: 'signed' },
              { type: 'redacted_thinking', data: 'encrypted' },
              { type: 'tool_use', id: 'tool-1', name: 'lookup', input: { query: 'cuba' } }
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 11, output_tokens: 7 }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    ) as unknown as typeof fetch

    const result = await completeAnthropicChat(
      instance,
      { ...request, target: { ...request.target, providerKind: 'anthropic' } },
      fetchImpl
    )

    expect(result.data?.message.thinking_blocks).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'signed' },
      { type: 'redacted_thinking', data: 'encrypted' }
    ])
    expect(result.data?.message.tool_calls?.[0]).toMatchObject({ id: 'tool-1' })
  })

  it('preserves fragmented Ollama NDJSON records', async () => {
    const instance: ProviderInstance = {
      id: 'ollama',
      name: 'Ollama',
      type: 'ollama',
      enabled: true,
      baseUrl: 'http://localhost:11434',
      modelSource: 'discover',
      models: []
    }
    const response = streamingResponse([
      '{"message":{"content":"hel',
      'lo"},"done":false}\n{"done":true,"prompt_eval_count":2,"eval_count":1}\n'
    ])
    const chunks: ProviderStreamChunk[] = []
    const result = await streamOllamaChat(
      instance,
      { ...request, target: { ...request.target, providerKind: 'ollama' } },
      (chunk) => chunks.push(chunk),
      vi.fn(async () => response) as unknown as typeof fetch
    )
    expect(result).toEqual({ ok: true })
    expect(text(chunks, 'content')).toBe('hello')
    expect(chunks.at(-1)).toMatchObject({ done: true, prompt_eval_count: 2, eval_count: 1 })
  })

  it('strips data URL prefixes and links Ollama tool images after the tool batch', () => {
    const converted = toOllamaMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'observe-1', function: { name: 'observe', arguments: {} } }]
      },
      {
        role: 'tool',
        tool_call_id: 'observe-1',
        content: 'Captured.',
        media: [
          {
            type: 'image',
            mimeType: 'image/png',
            source: { type: 'data_url', dataUrl: 'data:image/png;base64,AAAA' }
          }
        ]
      },
      { role: 'assistant', content: 'done' }
    ])

    expect(converted.map(({ role }) => role)).toEqual(['assistant', 'tool', 'user', 'assistant'])
    expect(converted[1]).not.toHaveProperty('images')
    expect(converted[2]).toMatchObject({
      role: 'user',
      content: 'Visual output from tool call observe-1',
      images: ['AAAA']
    })
  })

  it('surfaces Ollama errors delivered inside a successful NDJSON response', async () => {
    const instance: ProviderInstance = {
      id: 'ollama',
      name: 'Ollama',
      type: 'ollama',
      enabled: true,
      baseUrl: 'http://localhost:11434',
      modelSource: 'discover',
      models: []
    }
    const chunks: ProviderStreamChunk[] = []
    const result = await streamOllamaChat(
      instance,
      { ...request, target: { ...request.target, providerKind: 'ollama' } },
      (chunk) => chunks.push(chunk),
      vi.fn(async () =>
        streamingResponse(['{"error":"model unloaded"}\n'])
      ) as unknown as typeof fetch
    )

    expect(result).toEqual({ ok: false, error: 'model unloaded' })
    expect(chunks.at(-1)).toMatchObject({ done: true, done_reason: 'error' })
  })
})
