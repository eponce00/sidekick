import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Expand, MapPinned, X } from 'lucide-react'
import type { MapLinkLocation } from '../utils/mapLinks'
import './MessageMapCard.css'

const MessageMapPreview = lazy(() => import('./MessageMapPreview'))

function MapLoading(): React.JSX.Element {
  return (
    <div className="message-map-loading" role="status">
      <span aria-hidden="true" />
      <span>Loading interactive map…</span>
    </div>
  )
}

function MapSurface({ location }: { location: MapLinkLocation }): React.JSX.Element {
  return (
    <div className="message-map-surface">
      <Suspense fallback={<MapLoading />}>
        <MessageMapPreview location={location} />
      </Suspense>
    </div>
  )
}

function MapAddressLink({ location }: { location: MapLinkLocation }): React.JSX.Element {
  return (
    <a
      className="message-map-address"
      href={location.href}
      target="_blank"
      rel="noreferrer"
      title={`Open in ${location.providerLabel}`}
      aria-label={`Open ${location.label} in ${location.providerLabel}`}
    >
      {location.label}
    </a>
  )
}

export function MessageMapCard({ location }: { location: MapLinkLocation }): React.JSX.Element {
  const [fullscreen, setFullscreen] = useState(false)
  const fullscreenTriggerRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!fullscreen) return undefined
    const previousOverflow = document.body.style.overflow
    const fullscreenTrigger = fullscreenTriggerRef.current
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus({ preventScroll: true })
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setFullscreen(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') || []
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
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      fullscreenTrigger?.focus({ preventScroll: true })
    }
  }, [fullscreen])

  return (
    <>
      <section className="message-map-card">
        <div className="message-map-header">
          <div className="message-map-summary">
            <span className="message-map-icon" aria-hidden="true">
              <MapPinned size={15} />
            </span>
            <span className="message-map-copy">
              <strong>
                <MapAddressLink location={location} />
              </strong>
              <small>{location.providerLabel}</small>
            </span>
          </div>
          <div className="message-map-controls">
            <button
              ref={fullscreenTriggerRef}
              type="button"
              onClick={() => setFullscreen(true)}
              title="Open full screen"
              aria-label="Open map full screen"
            >
              <Expand size={14} />
            </button>
          </div>
        </div>
        <MapSurface location={location} />
      </section>
      {fullscreen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={dialogRef}
            className="message-map-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`Interactive map for ${location.label}`}
          >
            <div className="message-map-dialog-header">
              <div>
                <strong>
                  <MapAddressLink location={location} />
                </strong>
                <span>{location.providerLabel}</span>
              </div>
              <button
                ref={closeRef}
                type="button"
                className="message-map-dialog-close"
                onClick={() => setFullscreen(false)}
                aria-label="Close large map"
              >
                <X size={17} />
              </button>
            </div>
            <div className="message-map-dialog-surface">
              <Suspense fallback={<MapLoading />}>
                <MessageMapPreview location={location} />
              </Suspense>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
