import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import { rehypeTwemoji } from 'rehype-twemoji'
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ImageOff,
  MapPin,
  Maximize2,
  X
} from 'lucide-react'
import { parseMessageWithArtifacts } from '../utils/artifactParser'
import { parseMapLink, type MapLinkLocation } from '../utils/mapLinks'
import Artifact from './artifacts/Artifact'
import { MessageMapCard } from './MessageMapCard'
import './MessageMarkdown.css'

interface MarkdownNode {
  type?: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: MarkdownNode[]
}

interface GalleryImage {
  src: string
  alt: string
  title?: string
  sourceHref?: string
}

interface MessageMarkdownProps {
  content: string
  richMedia?: boolean
  isStreaming?: boolean
  onArtifactResult?: (
    title: string,
    result: { success: boolean; error?: string; code?: string }
  ) => void
}

interface ImageHints {
  alt: string
  position?: 'left' | 'right'
  size?: 'small' | 'medium' | 'half' | 'large'
}

function stringProperty(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

function safeImageSource(value: unknown): string | undefined {
  const source = stringProperty(value)
  if (!source) return undefined
  if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);/i.test(source)) return source
  try {
    const protocol = new URL(source).protocol
    return protocol === 'https:' || protocol === 'http:' ? source : undefined
  } catch {
    return undefined
  }
}

function parseImageHints(value?: string): ImageHints {
  const [rawAlt = '', ...rawHints] = (value || '').split('|')
  const hints = rawHints.map((hint) => hint.trim().toLowerCase())
  const position = hints.find((hint) => hint === 'left' || hint === 'right') as
    | ImageHints['position']
    | undefined
  const size = hints.find((hint) => ['small', 'medium', 'half', 'large'].includes(hint)) as
    | ImageHints['size']
    | undefined
  return { alt: rawAlt.trim() || 'Shared image', position, size }
}

function meaningfulChildren(node: MarkdownNode): MarkdownNode[] {
  return (node.children || []).filter(
    (child) => child.type !== 'text' || Boolean(child.value?.trim())
  )
}

function imageFromNode(node: MarkdownNode): GalleryImage | null {
  if (node.type === 'element' && node.tagName === 'img') {
    const properties = node.properties || {}
    if ('dataTwemoji' in properties || 'data-twemoji' in properties) return null
    const src = safeImageSource(properties.src)
    if (!src) return null
    const hints = parseImageHints(stringProperty(properties.alt))
    return {
      src,
      alt: hints.alt,
      title: stringProperty(properties.title)
    }
  }

  if (node.type === 'element' && node.tagName === 'a') {
    const children = meaningfulChildren(node)
    if (children.length !== 1) return null
    const image = imageFromNode(children[0])
    if (!image) return null
    return {
      ...image,
      sourceHref: isExternalHref(stringProperty(node.properties?.href))
        ? stringProperty(node.properties?.href)
        : image.src
    }
  }

  return null
}

function galleryImagesFromParagraph(node?: MarkdownNode): GalleryImage[] | null {
  if (!node) return null
  const children = meaningfulChildren(node)
  if (children.length === 0) return null
  const images = children.map(imageFromNode)
  if (images.some((image) => !image)) return null
  return images as GalleryImage[]
}

function textFromNode(node: MarkdownNode): string {
  if (node.type === 'text') return node.value || ''
  return (node.children || []).map(textFromNode).join('')
}

function isLocationPin(node: MarkdownNode): boolean {
  if (node.type !== 'element' || node.tagName !== 'img') return false
  const properties = node.properties || {}
  if (!('dataTwemoji' in properties || 'data-twemoji' in properties)) return false
  const alt = stringProperty(properties.alt)
  return alt === '📍' || alt === '🗺️' || alt === '🗺'
}

function mapLocationFromParagraph(node?: MarkdownNode): MapLinkLocation | null {
  if (!node) return null
  const children = meaningfulChildren(node)
  const links = children.filter((child) => child.type === 'element' && child.tagName === 'a')
  if (links.length !== 1 || children.some((child) => child !== links[0] && !isLocationPin(child))) {
    return null
  }
  const href = stringProperty(links[0].properties?.href)
  return href ? parseMapLink(href, textFromNode(links[0]).trim()) : null
}

function isExternalHref(href?: string): boolean {
  if (!href) return false
  try {
    const protocol = new URL(href).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

function sourceLabel(src: string): string {
  try {
    return new URL(src).hostname.replace(/^www\./, '')
  } catch {
    return 'Original image'
  }
}

function GalleryTile({
  image,
  index,
  total,
  hiddenCount,
  onOpen
}: {
  image: GalleryImage
  index: number
  total: number
  hiddenCount: number
  onOpen: (index: number, trigger: HTMLButtonElement) => void
}): React.JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  return (
    <button
      type="button"
      className={`message-image-tile ${loaded ? 'is-loaded' : ''} ${failed ? 'is-failed' : ''}`}
      aria-label={`Open image ${index + 1} of ${total}: ${image.alt}`}
      onClick={(event) => onOpen(index, event.currentTarget)}
    >
      {!loaded && !failed && <span className="message-image-skeleton" aria-hidden="true" />}
      {failed ? (
        <span className="message-image-error">
          <ImageOff size={17} aria-hidden="true" />
          <span>Image unavailable</span>
        </span>
      ) : (
        <img
          src={image.src}
          alt={image.alt}
          title={image.title}
          loading="lazy"
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
      <span className="message-image-caption">{image.alt}</span>
      <span className="message-image-expand" aria-hidden="true">
        <Maximize2 size={13} />
      </span>
      {hiddenCount > 0 && (
        <span className="message-image-more" aria-hidden="true">
          +{hiddenCount}
        </span>
      )}
    </button>
  )
}

function MessageImageGallery({ images }: { images: GalleryImage[] }): React.JSX.Element {
  const galleryId = useId()
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const lightboxRef = useRef<HTMLDivElement | null>(null)
  const visibleImages = images.slice(0, 4)
  const lightboxOpen = activeIndex !== null

  const close = useCallback((): void => setActiveIndex(null), [])
  const move = useCallback(
    (direction: -1 | 1): void => {
      setActiveIndex((current) => {
        if (current === null) return null
        return (current + direction + images.length) % images.length
      })
    },
    [images.length]
  )

  useEffect(() => {
    if (!lightboxOpen) return undefined
    closeRef.current?.focus({ preventScroll: true })
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
      if (event.key === 'ArrowLeft') move(-1)
      if (event.key === 'ArrowRight') move(1)
      if (event.key === 'Tab') {
        const focusable = Array.from(
          lightboxRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ||
            []
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      triggerRef.current?.focus({ preventScroll: true })
    }
  }, [close, lightboxOpen, move])

  const activeImage = activeIndex === null ? null : images[activeIndex]

  return (
    <>
      <div
        className={`message-image-gallery message-image-gallery-${Math.min(images.length, 4)}`}
        data-count={images.length}
        aria-label={`${images.length} shared ${images.length === 1 ? 'image' : 'images'}`}
      >
        {visibleImages.map((image, index) => (
          <GalleryTile
            key={`${galleryId}-${index}-${image.src}`}
            image={image}
            index={index}
            total={images.length}
            hiddenCount={index === 3 ? images.length - visibleImages.length : 0}
            onOpen={(nextIndex, trigger) => {
              triggerRef.current = trigger
              setActiveIndex(nextIndex)
            }}
          />
        ))}
      </div>
      {activeImage &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={lightboxRef}
            className="message-image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={`Image preview: ${activeImage.alt}`}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) close()
            }}
          >
            <div className="message-image-lightbox-toolbar">
              <div className="message-image-lightbox-copy">
                <strong>{activeImage.alt}</strong>
                <span>
                  {(activeIndex || 0) + 1} of {images.length} · {sourceLabel(activeImage.src)}
                </span>
              </div>
              <a
                href={activeImage.sourceHref || activeImage.src}
                target="_blank"
                rel="noreferrer"
                className="message-image-lightbox-source"
              >
                <span>Open original</span>
                <ExternalLink size={13} aria-hidden="true" />
              </a>
              <button
                ref={closeRef}
                type="button"
                className="message-image-lightbox-close"
                onClick={close}
                aria-label="Close image preview"
              >
                <X size={17} />
              </button>
            </div>
            <div className="message-image-lightbox-stage">
              {images.length > 1 && (
                <button
                  type="button"
                  className="message-image-lightbox-nav previous"
                  onClick={() => move(-1)}
                  aria-label="Previous image"
                >
                  <ChevronLeft size={21} />
                </button>
              )}
              <img src={activeImage.src} alt={activeImage.alt} draggable={false} />
              {images.length > 1 && (
                <button
                  type="button"
                  className="message-image-lightbox-nav next"
                  onClick={() => move(1)}
                  aria-label="Next image"
                >
                  <ChevronRight size={21} />
                </button>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

function MarkdownImage({
  node: _node,
  alt,
  className,
  ...props
}: ComponentPropsWithoutRef<'img'> & { node?: unknown }): React.JSX.Element {
  const hints = parseImageHints(alt)
  const hintClasses = [
    hints.position ? `doc-img--${hints.position}` : '',
    hints.size ? `doc-img--${hints.size}` : ''
  ]
    .filter(Boolean)
    .join(' ')
  const isTwemoji = Boolean(props['data-twemoji'])
  return (
    <img
      {...props}
      alt={hints.alt}
      className={[className, isTwemoji ? '' : 'doc-img', hintClasses].filter(Boolean).join(' ')}
      {...(isTwemoji
        ? {}
        : { loading: 'lazy' as const, decoding: 'async' as const, referrerPolicy: 'no-referrer' })}
    />
  )
}

function MarkdownLink({
  node: _node,
  href,
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<'a'> & { node?: unknown }): React.JSX.Element {
  const mapLink = Boolean(href && parseMapLink(href, ''))
  const external = isExternalHref(href)
  return (
    <a
      {...props}
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer' : undefined}
      className={[className, 'markdown-link', mapLink ? 'markdown-map-link' : '']
        .filter(Boolean)
        .join(' ')}
    >
      {mapLink && <MapPin size={13} aria-hidden="true" />}
      <span>{children}</span>
      {!mapLink && <ExternalLink className="markdown-link-external" size={11} aria-hidden="true" />}
    </a>
  )
}

function MarkdownParagraph({
  node,
  children,
  richMedia,
  ...props
}: ComponentPropsWithoutRef<'p'> & {
  node?: MarkdownNode
  richMedia: boolean
}): React.JSX.Element {
  const location = richMedia ? mapLocationFromParagraph(node) : null
  if (location) return <MessageMapCard location={location} />
  const images = richMedia ? galleryImagesFromParagraph(node) : null
  if (images) return <MessageImageGallery images={images} />
  return <p {...props}>{children}</p>
}

function RichMarkdownParagraph(
  props: ComponentPropsWithoutRef<'p'> & { node?: unknown }
): React.JSX.Element {
  const { node, children, ...paragraphProps } = props
  return (
    <MarkdownParagraph node={node as MarkdownNode} richMedia {...paragraphProps}>
      {children}
    </MarkdownParagraph>
  )
}

function PlainMarkdownParagraph(
  props: ComponentPropsWithoutRef<'p'> & { node?: unknown }
): React.JSX.Element {
  const { node, children, ...paragraphProps } = props
  return (
    <MarkdownParagraph node={node as MarkdownNode} richMedia={false} {...paragraphProps}>
      {children}
    </MarkdownParagraph>
  )
}

function withoutStreamingImages(content: string): string {
  return content.replace(/!\[[^\]]*\]\((?:https?:\/\/|data:image\/)[^)\n]+\)/giu, '')
}

export function MessageMarkdown({
  content,
  richMedia = true,
  isStreaming = false,
  onArtifactResult
}: MessageMarkdownProps): React.JSX.Element {
  const renderCode = ({
    node: _node,
    inline: _inline,
    children,
    ...props
  }: ComponentPropsWithoutRef<'code'> & { node?: unknown; inline?: boolean }): ReactNode => {
    if (onArtifactResult) {
      const parsedResult = parseMessageWithArtifacts(String(children))
      const artifactSegments = parsedResult.segments.filter(
        (segment) => segment.type === 'artifact' && segment.artifact
      )
      if (artifactSegments.length > 0) {
        return artifactSegments.map((segment, index) => (
          <Artifact
            key={`${segment.artifact!.title}-${index}`}
            artifact={segment.artifact!}
            onResult={(result) => onArtifactResult(segment.artifact!.title, result)}
          />
        ))
      }
    }
    return <code {...props}>{children}</code>
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeHighlight, rehypeKatex, rehypeTwemoji]}
      components={{
        code: renderCode,
        img: MarkdownImage,
        a: MarkdownLink,
        p: richMedia && !isStreaming ? RichMarkdownParagraph : PlainMarkdownParagraph
      }}
    >
      {isStreaming ? withoutStreamingImages(content) : content}
    </ReactMarkdown>
  )
}
