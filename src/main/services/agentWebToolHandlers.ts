import {
  toolExecutionFailed,
  toolExecutionSucceeded,
  type ToolExecutionResult,
  type ToolResultImageMimeType,
  type ToolResultMediaAttachment
} from '../../shared/agentRuntime'
import { searchImages } from './sidekickSearch/imageSearch'
import { readPage } from './sidekickSearch/pageReader'
import { searchWeb } from './sidekickSearch/searchCoordinator'
import type { ImageSearchResult, PageContent } from './sidekickSearch/types'
import type { ToolOutputStore } from './toolOutputStore'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'

/**
 * A page that could not be read is a failed call. Reporting it as a success
 * with the failure buried in the payload let the UI show a green check and let
 * the model later describe the fetch as confirmed.
 */
export function pageFetchFailure(title: string, page: PageContent): ToolExecutionResult | null {
  if (page.success) return null
  const reason = page.error || 'The page could not be read'
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

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback))
}

export function registerWebToolHandlers(
  registry: AgentToolHandlerRegistry,
  outputs: ToolOutputStore
): void {
  registry.register('web_search', async ({ title, arguments: args }) => {
    const data = await searchWeb(String(args.query || ''), bounded(args.limit, 8, 1, 20))
    return toolExecutionSucceeded({ title, data })
  })
  registry.register('web_image_search', async ({ title, arguments: args }) => {
    const results = await searchImages(String(args.query || ''), 8, {
      includeImageData: args.include_image_data === true,
      maxImagesWithData: 1
    })
    return imageSearchToolResult(title, results)
  })
  registry.register('web_fetch', async ({ title, arguments: args }) => {
    const data = await readPage(String(args.url || ''))
    const failure = pageFetchFailure(title, data)
    if (failure) return failure
    const boundedOutput = await outputs.apply(JSON.stringify(data), { preview: 'head-tail' })
    return toolExecutionSucceeded({
      title,
      data,
      modelContent: boundedOutput.content,
      output: boundedOutput.output
    })
  })
}
