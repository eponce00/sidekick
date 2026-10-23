import { createContext, useContext, useEffect, useState } from 'react'

/**
 * Where the chat is shown. The desktop window is the default: images load from their own
 * address and every card works. The phone companion shows the same components on a page that
 * may load nothing from elsewhere and cannot reach the computer's windows, so it says how.
 */
export interface ChatSurface {
  /** Fetches an image the page cannot load itself; null when it cannot be shown here. */
  resolveImage?: (src: string) => Promise<string | null>
  /** What cards that only work on the computer, such as artifacts, say instead. */
  computerOnly?: string
  /** The page may load nothing from the network, so interactive maps are left out. */
  offline?: boolean
}

export const ChatSurfaceContext = createContext<ChatSurface>({})

export function useChatSurface(): ChatSurface {
  return useContext(ChatSurfaceContext)
}

/**
 * The address to show an image from. Without a resolver it is the image's own; with one it is
 * undefined while the resolver works, and `failed` when the image cannot be shown.
 */
export function useImageSource(src: string | undefined): {
  src: string | undefined
  failed: boolean
} {
  const { resolveImage } = useChatSurface()
  const [resolved, setResolved] = useState<{ for: string; src: string | null } | null>(null)
  useEffect(() => {
    if (!resolveImage || !src) return undefined
    let current = true
    resolveImage(src).then(
      (value) => current && setResolved({ for: src, src: value }),
      () => current && setResolved({ for: src, src: null })
    )
    return () => {
      current = false
    }
  }, [resolveImage, src])
  if (!resolveImage) return { src, failed: false }
  if (!src) return { src: undefined, failed: true }
  if (resolved?.for !== src) return { src: undefined, failed: false }
  return { src: resolved.src ?? undefined, failed: resolved.src === null }
}
