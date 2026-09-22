import type { ProviderChatMessage } from './providerRuntime'

/** Used when a provider rejects the image count without saying what it accepts. */
export const FALLBACK_IMAGE_BUDGET = 1

export interface ImageBudgetResult {
  messages: ProviderChatMessage[]
  /** Images removed from the transcript to fit the budget. */
  removed: number
}

function imageCount(message: ProviderChatMessage): number {
  return (
    (message.images?.length ?? 0) + (message.media?.filter((m) => m.type === 'image').length ?? 0)
  )
}

/**
 * Keep only the most recent `maxImages` images across the transcript. Older
 * images are dropped and the message says so, so the model knows a screenshot
 * or attachment existed there even though it can no longer see it.
 */
export function enforceImageBudget(
  messages: ProviderChatMessage[],
  maxImages: number
): ImageBudgetResult {
  const budget = Math.max(0, Math.floor(maxImages))
  let remaining = budget
  let removed = 0
  const next = [...messages]
  // Walk newest to oldest so the budget is spent on the images the model most
  // recently acted on.
  for (let index = next.length - 1; index >= 0; index--) {
    const message = next[index]
    const count = imageCount(message)
    if (count === 0) continue
    if (count <= remaining) {
      remaining -= count
      continue
    }
    const keep = remaining
    remaining = 0
    const media = message.media ?? []
    const images = message.images ?? []
    // Within one message, later media/images are newer; keep from the end.
    const keptMedia = keep > 0 ? media.slice(Math.max(0, media.length - keep)) : []
    const keepImages = Math.max(0, keep - keptMedia.length)
    const keptImages = keepImages > 0 ? images.slice(Math.max(0, images.length - keepImages)) : []
    const dropped = count - keptMedia.length - keptImages.length
    removed += dropped
    const note =
      dropped === 1
        ? '[1 earlier image omitted: the model accepts a limited number of images per request]'
        : `[${dropped} earlier images omitted: the model accepts a limited number of images per request]`
    next[index] = {
      ...message,
      content: message.content ? `${message.content}\n${note}` : note,
      ...(keptImages.length ? { images: keptImages } : { images: undefined }),
      ...(keptMedia.length
        ? { media: [...(message.media ?? []).filter((m) => m.type !== 'image'), ...keptMedia] }
        : { media: (message.media ?? []).filter((m) => m.type !== 'image') })
    }
    if (!next[index].images) delete next[index].images
    if (!next[index].media?.length) delete next[index].media
  }
  return { messages: next, removed }
}

/** Total images a transcript would send. */
export function countTranscriptImages(messages: ProviderChatMessage[]): number {
  return messages.reduce((total, message) => total + imageCount(message), 0)
}
