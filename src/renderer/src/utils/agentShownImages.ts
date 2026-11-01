import type { ContentSegment, ToolExecution } from '../types/chat.types'

// The app's own store of reduced copies; nothing else a tool result names is shown.
const LOCAL_IMAGE = 'sidekick-browser://artifact/'

export interface AgentShownImage {
  src: string
  alt: string
  caption?: string
  /** The same page read twice is one image, the newest copy. */
  key: string
}

function fileName(path: unknown): string {
  return typeof path === 'string' ? (path.split(/[\\/]/).pop() ?? '') : ''
}

/** The PDF pages one read showed the model. */
export function pdfPagesShownBy(tool: ToolExecution): AgentShownImage[] {
  const data = tool.data as { path?: unknown; pagePreviews?: unknown } | null | undefined
  if (!Array.isArray(data?.pagePreviews)) return []
  const file = fileName(data.path)
  return data.pagePreviews.flatMap((preview: { page?: unknown; url?: unknown }) =>
    typeof preview?.page === 'number' &&
    typeof preview.url === 'string' &&
    preview.url.startsWith(LOCAL_IMAGE)
      ? [
          {
            src: preview.url,
            alt: `Page ${preview.page}${file ? ` of ${file}` : ''}`,
            caption: `Page ${preview.page}`,
            key: `${String(data.path)}:${preview.page}`
          }
        ]
      : []
  )
}

/**
 * What the model looked at in a stretch of work: PDF pages and images it opened, and the latest
 * look at each app it operated. Browser screenshots stay with their own rows: a run can take dozens,
 * and the Browser panel shows them.
 */
export function agentShownImages(segments: readonly ContentSegment[] = []): AgentShownImage[] {
  const shown = new Map<string, AgentShownImage>()
  for (const segment of segments) {
    if (segment.type !== 'tool' || !segment.tool) continue
    const { tool } = segment
    for (const page of pdfPagesShownBy(tool)) {
      shown.delete(page.key)
      shown.set(page.key, page)
    }
    const data = tool.data as
      | { path?: unknown; previewUrl?: unknown; app?: unknown }
      | null
      | undefined
    if (
      tool.name === 'computer' &&
      typeof data?.previewUrl === 'string' &&
      data.previewUrl.startsWith(LOCAL_IMAGE)
    ) {
      const app = String(data.app)
      const key = `computer:${app.toLowerCase()}`
      shown.delete(key)
      shown.set(key, { src: data.previewUrl, alt: `The ${app} window`, caption: app, key })
    }
    if (
      tool.name === 'view_image' &&
      typeof data?.previewUrl === 'string' &&
      data.previewUrl.startsWith(LOCAL_IMAGE)
    ) {
      const key = String(data.path)
      shown.delete(key)
      shown.set(key, { src: data.previewUrl, alt: fileName(data.path) || 'Image', key })
    }
  }
  return [...shown.values()]
}
