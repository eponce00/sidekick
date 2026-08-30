import { toolExecutionSucceeded } from '../../shared/agentRuntime'
import { searchImages } from './sidekickSearch/imageSearch'
import { readPage } from './sidekickSearch/pageReader'
import { searchWeb } from './sidekickSearch/searchCoordinator'
import type { ToolOutputStore } from './toolOutputStore'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'

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
      maxImagesWithData: 3
    })
    return toolExecutionSucceeded({ title, data: { results } })
  })
  registry.register('web_fetch', async ({ title, arguments: args }) => {
    const data = await readPage(String(args.url || ''))
    const boundedOutput = await outputs.apply(JSON.stringify(data), { preview: 'head-tail' })
    return toolExecutionSucceeded({
      title,
      data,
      modelContent: boundedOutput.content,
      output: boundedOutput.output
    })
  })
}
