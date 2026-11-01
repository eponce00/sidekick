import { describe, expect, it, vi } from 'vitest'
import { toOpenAICompatibleMessages } from '../providers/providerRuntime'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import {
  imageSearchToolResult,
  pageFetchFailure,
  registerWebToolHandlers,
  searchFailure
} from './agentWebToolHandlers'
import { structuredTextPage } from './sidekickSearch/pageReader'
import type {
  ImageSearchResult,
  PageContent,
  SearchResponse,
  SearchSourceId
} from './sidekickSearch/types'
import type { ToolOutputStore } from './toolOutputStore'

const LARGE_IMAGE_BASE64 = 'QUFB'.repeat(30_000)

function imageResult(overrides: Partial<ImageSearchResult> = {}): ImageSearchResult {
  return {
    title: 'Controller reference',
    imageUrl: 'https://images.example/controller.jpg',
    thumbnailUrl: 'https://images.example/controller-thumb.jpg',
    pageUrl: 'https://example.com/controller',
    source: 'Example',
    resolution: '1200×800',
    mimeType: 'image/jpeg',
    imageBase64: LARGE_IMAGE_BASE64,
    ...overrides
  }
}

describe('agent web image results', () => {
  it('keeps image bytes out of model text and UI search metadata', () => {
    const result = imageSearchToolResult('Image search: controller', [
      imageResult(),
      imageResult({ title: 'Second result', imageBase64: 'QkJC'.repeat(100) })
    ])

    expect(result.modelContent.length).toBeLessThan(2_000)
    expect(result.modelContent).not.toContain(LARGE_IMAGE_BASE64)
    expect(result.modelContent).toContain('https://images.example/controller.jpg')
    expect(result.data?.results).toHaveLength(2)
    expect(result.data?.results[0]).not.toHaveProperty('imageBase64')
    expect(result.media).toHaveLength(1)
    expect(result.media?.[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/jpeg',
      source: { type: 'data_url', dataUrl: `data:image/jpeg;base64,${LARGE_IMAGE_BASE64}` }
    })
  })

  it('serializes visual bytes as a typed provider image instead of tool text', () => {
    const result = imageSearchToolResult('Image search: controller', [imageResult()])
    const messages = toOpenAICompatibleMessages([
      {
        role: 'tool',
        tool_call_id: 'search-1',
        content: result.modelContent,
        media: result.media
      }
    ])

    expect(messages[0]).toMatchObject({ role: 'tool', content: result.modelContent })
    expect(String(messages[0].content)).not.toContain(LARGE_IMAGE_BASE64)
    expect(messages[1]).toMatchObject({
      role: 'user',
      content: expect.arrayContaining([
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${LARGE_IMAGE_BASE64}` } }
      ])
    })
  })

  it('does not attach unsupported image types', () => {
    const result = imageSearchToolResult('Image search: controller', [
      imageResult({ mimeType: 'image/avif' })
    ])

    expect(result.media).toBeUndefined()
    expect(result.modelContent).toContain('"visualAttachments":0')
  })
})

describe('agent web searches', () => {
  it('reports a search every engine refused as a failure that names the engines', () => {
    const engine = (source: SearchSourceId, status: 'empty' | 'rate_limited') => ({
      source,
      status,
      resultCount: 0,
      durationMs: 5,
      ...(status === 'rate_limited'
        ? { error: 'HTTP 429 (too many requests)', retryAt: 5 * 60_000 }
        : {})
    })
    const response = (statuses: Array<'empty' | 'rate_limited'>): SearchResponse => ({
      query: 'vllm max tokens',
      results: [],
      diagnostics: statuses.map((status, index) =>
        engine((['duckduckgo', 'brave', 'bing'] as const)[index], status)
      ),
      cached: false
    })

    const failure = searchFailure(
      'Search',
      response(['rate_limited', 'rate_limited', 'rate_limited']),
      0
    )

    expect(failure?.error).toMatchObject({ code: 'transient', recoveryAction: 'change_strategy' })
    expect(failure?.error?.message).toContain('DuckDuckGo: HTTP 429 (too many requests)')
    expect(failure?.error?.message).toContain('not the model provider')
    expect(failure?.error?.message).toContain('next 5 minutes')
    // Engines that answered with nothing found make an ordinary empty result.
    expect(searchFailure('Search', response(['rate_limited', 'empty', 'empty']), 0)).toBeNull()
  })
})

describe('agent web page fetches', () => {
  const page = (overrides: Partial<PageContent>): PageContent => ({
    url: 'https://api.open-meteo.com/v1/forecast',
    title: '',
    content: '',
    excerpt: '',
    byline: '',
    siteName: '',
    success: false,
    ...overrides
  })

  it('reports an unreadable page as a failed call rather than a success', () => {
    const failure = pageFetchFailure(
      'Fetch: forecast',
      page({ error: 'Unsupported page content type: image/png' })
    )
    expect(failure).toMatchObject({
      status: 'error',
      error: { code: 'unsupported', retryable: false }
    })
    expect(pageFetchFailure('Fetch: bad', page({ error: 'Invalid URL' }))?.error?.code).toBe(
      'invalid_arguments'
    )
    expect(pageFetchFailure('Fetch: down', page({ error: 'socket hang up' }))?.error).toMatchObject(
      { code: 'transient', retryable: true }
    )
    expect(pageFetchFailure('Fetch: ok', page({ success: true, content: 'Hi' }))).toBeNull()
    expect(
      pageFetchFailure('Fetch: router', page({ error: 'Not allowed', refused: true }))?.error
    ).toMatchObject({
      code: 'permission_denied',
      retryable: false,
      recoveryAction: 'change_strategy'
    })
  })

  it("asks the browser's local-network question for a device, under the call's signal", async () => {
    const policy = { approved: vi.fn(() => false), approve: vi.fn(async () => false) }
    const registry = new AgentToolHandlerRegistry()
    registerWebToolHandlers(registry, {} as ToolOutputStore, policy)
    const run = new AbortController()
    const result = await registry.execute({
      name: 'web_fetch',
      title: 'Fetch: router',
      arguments: { url: 'http://192.168.1.1/' },
      context: { runId: 'run-1', signal: run.signal }
    })

    expect(policy.approve).toHaveBeenCalledWith('http://192.168.1.1', run.signal)
    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'permission_denied', retryable: false }
    })
  })

  it('reads an API response as its data instead of refusing it', () => {
    // Refusing JSON sent a model to fetch the data another way and then
    // describe the API as confirmed without having read it.
    const url = new URL('https://api.open-meteo.com/v1/forecast?latitude=39.5')
    const json = structuredTextPage(
      url,
      'application/json; charset=utf-8',
      '{"current":{"temperature_2m":24.1}}',
      10_000
    )
    expect(json).toMatchObject({ success: true, siteName: 'api.open-meteo.com' })
    expect(json?.content).toContain('"temperature_2m": 24.1')

    const text = structuredTextPage(new URL('https://example.com/a.txt'), 'text/plain', 'plain', 10)
    expect(text?.content).toBe('plain')
    expect(structuredTextPage(url, 'text/html', '<p>hi</p>', 10_000)).toBeNull()
    expect(
      structuredTextPage(url, 'application/json', 'x'.repeat(50), 1_000)?.content.length
    ).toBeLessThan(1_100)
  })
})
