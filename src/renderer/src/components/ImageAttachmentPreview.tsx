import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, X } from 'lucide-react'
import type { ReadableImageMimeType } from '../../../shared/imageContent'
import { describeImageReduction, type ProviderImageProfile } from '../../../shared/imagePreparation'
import { dataUrlByteLength, type MessageImageAttachment } from '../../../shared/messageImages'
import './ImageAttachmentPreview.css'

interface ImageAttachmentPreviewProps {
  image: MessageImageAttachment
  className?: string
  /** What the selected model accepts; the preview then says when it will get a smaller copy. */
  sendProfile?: ProviderImageProfile
}

export function ImageAttachmentPreview({
  image,
  className = '',
  sendProfile
}: ImageAttachmentPreviewProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const reduction =
    sendProfile && size
      ? describeImageReduction(
          {
            mimeType: image.mimeType as ReadableImageMimeType,
            ...size,
            bytes: dataUrlByteLength(image.dataUrl)
          },
          sendProfile
        )
      : undefined

  useEffect(() => {
    if (!open) return
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    closeButtonRef.current?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus({ preventScroll: true })
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        className={`image-attachment-preview ${className}`.trim()}
        onClick={() => setOpen(true)}
        title={reduction ? `Open ${image.name}\n${reduction}` : `Open ${image.name}`}
        aria-label={`Open ${image.name}`}
        aria-description={reduction}
      >
        <img
          src={image.dataUrl}
          alt={image.name}
          onLoad={(event) =>
            setSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight
            })
          }
        />
        <span className="image-attachment-expand" aria-hidden="true">
          <Maximize2 size={14} strokeWidth={1.8} />
        </span>
      </button>
      {open &&
        createPortal(
          <div
            className="image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={`Image preview: ${image.name}`}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false)
            }}
          >
            <div className="image-lightbox-content">
              <img src={image.dataUrl} alt={image.name} />
              <div className="image-lightbox-footer">
                <span title={image.name}>{image.name}</span>
                {reduction && <span className="image-lightbox-note">{reduction}</span>}
                <span>Esc to close</span>
              </div>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              className="image-lightbox-close"
              onClick={() => setOpen(false)}
              title="Close image preview"
              aria-label="Close image preview"
            >
              <X size={18} />
            </button>
          </div>,
          document.body
        )}
    </>
  )
}
