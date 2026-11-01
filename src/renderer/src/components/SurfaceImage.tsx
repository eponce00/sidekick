import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { useChatSurface, useImageSource } from './chatSurface'

/** An image shown through the surface: `fallback` stands in when it cannot be shown. */
export function SurfaceImage({
  src,
  fallback = null,
  ...props
}: ComponentPropsWithoutRef<'img'> & { fallback?: ReactNode }): React.JSX.Element | null {
  const source = useImageSource(src)
  const { resolveImage } = useChatSurface()
  if (!resolveImage) return <img {...props} src={src} />
  if (source.failed) return <>{fallback}</>
  if (!source.src) return null
  return <img {...props} src={source.src} />
}
