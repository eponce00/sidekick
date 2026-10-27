import {
  toolExecutionFailed,
  toolExecutionSucceeded,
  type ToolExecutionResult,
  type ToolResultImageMimeType,
  type ToolResultMediaAttachment
} from '../../shared/agentRuntime'
import { browserNetworkApprovals, type BrowserNetworkPolicy } from './browserNetworkApprovals'
import { searchImages } from './sidekickSearch/imageSearch'
import { digestPage } from './sidekickSearch/pageDigest'
import { readPage } from './sidekickSearch/pageReader'
import { searchWeb } from './sidekickSearch/searchCoordinator'
import type {
  ImageSearchResult,
  PageContent,
  SearchResponse,
  SearchSourceId
} from './sidekickSearch/types'
import type { ToolOutputStore } from './toolOutputStore'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'

/** One page read, leaving room in the tool result bound for the note on what was left out. */
const PAGE_READ_TOKENS = 6_000

/**
 * A page that could not be read is a failed call. Reporting it as a success
 * with the failure buried in the payload let the UI show a green check and let
 * the model later describe the fetch as confirmed.
 */
export function pageFetchFailure(title: string, page: PageContent): ToolExecutionResult | null {
  if (page.success) return null
  const reason = page.error || 'The page could not be read'
  if (page.refused) {
    return toolExecutionFailed({
      title,
      code: 'permission_denied',
      message: reason,
      retryable: false,
      recoveryAction: 'change_strategy',
      data: page
    })
  }
  const unsupported = /^Unsupported page content type/i.test(reason)
  const invalid = /^(?:Invalid (?:page )?URL|Only HTTP and HTTPS)/i.test(reason)
  return toolExecutionFailed({
    title,
    code: unsupported ? 'unsupported' : invalid ? 'invalid_arguments' : 'transient',
    message: reason,
    retryable: !unsupported && !invalid,
    data: page
  })
}

type ImageSearchPresentationResult = Omit<ImageSearchResult, 'imageBase64'>

const WEB_IMAGE_MIME_TYPES = new Set<ToolResultImageMimeType>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
])

function webImageMimeType(value: string | undefined): ToolResultImageMimeType | undefined {
  const normalized = value?.toLowerCase() as ToolResultImageMimeType | undefined
  return normalized && WEB_IMAGE_MIME_TYPES.has(normalized) ? normalized : undefined
}

/**
 * Keep rich search data, model-facing text, and visual input as separate channels.
 * A single search contributes at most one visual; the provider boundary applies a
 * global two-image budget across parallel searches, uploads, and browser captures.
 */
export function imageSearchToolResult(
  title: string,
  results: ImageSearchResult[]
): ToolExecutionResult<{ results: ImageSearchPresentationResult[] }> {
  const presentationResults = results.map(({ imageBase64: _imageBase64, ...result }) => result)
  const media: ToolResultMediaAttachment[] = []
  for (const result of results) {
    const mimeType = webImageMimeType(result.mimeType)
    if (!result.imageBase64 || !mimeType) continue
    media.push({
      type: 'image',
      mimeType,
      name: result.title.slice(0, 500),
      description: `Top visual result from ${result.source || 'web image search'}`,
      source: {
        type: 'data_url',
        dataUrl: `data:${mimeType};base64,${result.imageBase64}`
      }
    })
    break
  }
  const data = { results: presentationResults }
  return toolExecutionSucceeded({
    title,
    data,
    modelContent: JSON.stringify({ ...data, visualAttachments: media.length }),
    media
  })
}

const ENGINE_NAMES: Record<SearchSourceId, string> = {
  duckduckgo: 'DuckDuckGo',
  brave: 'Brave',
  bing: 'Bing'
}

/**
 * A search where every engine failed is a failed call. Reported as an empty success with a bare
 * "HTTP 429" in each engine's diagnostics, an agent took the refusals for its own model server's
 * and kept searching. The message names who refused and when asking again can help.
 */
export function searchFailure(
  title: string,
  response: SearchResponse,
  now = Date.now()
): ToolExecutionResult | null {
  const { diagnostics } = response
  if (response.results.length > 0 || diagnostics.length === 0) return null
  if (
    !diagnostics.every((engine) => engine.status === 'error' || engine.status === 'rate_limited')
  ) {
    return null
  }
  const limited = diagnostics.filter((engine) => engine.status === 'rate_limited')
  const failures = diagnostics
    .map((engine) => `${ENGINE_NAMES[engine.source]}: ${engine.error || 'failed'}`)
    .join('; ')
  const comesBack = Math.min(...limited.map((engine) => engine.retryAt ?? now))
  const minutes = Math.max(1, Math.ceil((comesBack - now) / 60_000))
  const message =
    `Web search failed: every search engine failed (${failures}). These are the public search ` +
    `engines SideKick asks, not the model provider or any server in this task.` +
    (limited.length
      ? ` An engine that answers 429 is not asked again for a few minutes, so searching again ` +
        `in the next ${minutes} minute${minutes === 1 ? '' : 's'} fails the same way. Continue ` +
        `without web search, read a known page with web_fetch, or tell the user search is ` +
        `unavailable.`
      : '')
  return toolExecutionFailed({
    title,
    code: 'transient',
    message,
    retryable: true,
    recoveryAction: limited.length ? 'change_strategy' : 'retry_later',
    data: response,
    // Without it the model read only the diagnostics, and none of the above.
    modelContent: message
  })
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback))
}

export function registerWebToolHandlers(
  registry: AgentToolHandlerRegistry,
  outputs: ToolOutputStore,
  networkPolicy: BrowserNetworkPolicy = browserNetworkApprovals
): void {
  registry.register('web_search', async ({ title, arguments: args }) => {
    const data = await searchWeb(String(args.query || ''), bounded(args.limit, 8, 1, 20))
    return searchFailure(title, data) ?? toolExecutionSucceeded({ title, data })
  })
  registry.register('web_image_search', async ({ title, arguments: args }) => {
    const results = await searchImages(String(args.query || ''), 8, {
      includeImageData: args.include_image_data === true,
      maxImagesWithData: 1
    })
    return imageSearchToolResult(title, results)
  })
  registry.register('web_fetch', async ({ title, arguments: args, context }) => {
    // One approval covers the browser and web_fetch, and stopping the run withdraws the question.
    const data = await readPage(String(args.url || ''), undefined, {
      policy: networkPolicy,
      signal: context.signal
    })
    const failure = pageFetchFailure(title, data)
    if (failure) return failure
    const digest = digestPage(data, String(args.information_needed || ''), PAGE_READ_TOKENS)
    let modelContent = digest.text
    if (digest.reduced) {
      const handle = await outputs.save(digest.full)
      modelContent +=
        `\n\n[The page is longer than one read, so the parts that best match what you asked ` +
        `for were kept. The whole page in this form is tool_output handle "${handle}"; read it` +
        `with an offset, or fetch again asking for something else.]`
    }
    // Markdown, not JSON: escaped newlines made headings, lists and code hard to read.
    const boundedOutput = await outputs.apply(modelContent, { preview: 'head' })
    return toolExecutionSucceeded({
      title,
      data,
      modelContent: boundedOutput.content,
      output: boundedOutput.output
    })
  })
}
