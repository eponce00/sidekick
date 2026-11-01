import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { useBackLayer } from './navigation'

/** Space kept between the menu and the screen's edges, and between it and its button. */
const EDGE = 12
const GAP = 8

/**
 * A menu card that opens beside the button it belongs to, as the ChatGPT app's menus do: below and
 * to its right edge for the top bar's buttons, above and to its left edge for the message box's.
 * It closes with a tap elsewhere, Escape, or the phone's back gesture.
 */
export function Popover({
  label,
  anchor,
  placement,
  title,
  onBack,
  onClose,
  children
}: {
  label: string
  /** The button it opens from. */
  anchor: HTMLElement | null
  placement: 'below-end' | 'above-start'
  /** A quiet heading, such as the chat's name. */
  title?: string
  /** For a submenu: a back row that returns to the menu it came from. */
  onBack?: () => void
  onClose: () => void
  children: ReactNode
}) {
  const card = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<React.CSSProperties>({ visibility: 'hidden' })
  useBackLayer(true, onClose)

  useLayoutEffect(() => {
    const place = (): void => {
      const box = anchor?.getBoundingClientRect()
      const viewport = window.visualViewport
      const width = viewport?.width ?? window.innerWidth
      const height = viewport?.height ?? window.innerHeight
      if (!box) return setPosition({ top: EDGE, right: EDGE })
      setPosition(
        placement === 'below-end'
          ? {
              top: box.bottom + GAP,
              right: Math.max(EDGE, width - box.right),
              maxHeight: height - box.bottom - GAP - EDGE
            }
          : {
              bottom: Math.max(EDGE, height - box.top + GAP),
              left: Math.max(EDGE, box.left),
              maxHeight: box.top - GAP - EDGE
            }
      )
    }
    place()
    window.addEventListener('resize', place)
    window.visualViewport?.addEventListener('resize', place)
    return () => {
      window.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('resize', place)
    }
  }, [anchor, placement])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    card.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus({ preventScroll: true })
    }
  }, [onClose])

  return createPortal(
    <div
      className="cp-popover-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={card}
        className={`cp-popover is-${placement}`}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        style={position}
      >
        {onBack ? (
          <button type="button" className="cp-popover-back" onClick={onBack}>
            <ChevronLeft size={18} aria-hidden="true" />
            <span>{title}</span>
          </button>
        ) : (
          title && <div className="cp-popover-title">{title}</div>
        )}
        {children}
      </div>
    </div>,
    document.body
  )
}

/** One row of a popover: icon, name, and a check, an arrow to a submenu, or nothing. */
export function PopoverItem({
  icon,
  label,
  description,
  selected,
  submenu,
  disabled,
  tone,
  round,
  onClick
}: {
  icon?: ReactNode
  label: string
  description?: string
  selected?: boolean
  /** Opens a submenu, shown with an arrow. */
  submenu?: boolean
  disabled?: boolean
  /** A removal, drawn in the error colour. */
  tone?: 'danger'
  /** The icon in a round tile, as the message box's menu shows its attachments. */
  round?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role={selected === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={selected === undefined ? undefined : selected}
      className={`cp-popover-item${selected ? ' is-selected' : ''}${tone === 'danger' ? ' is-danger' : ''}${round ? ' is-round' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon && (
        <span className="cp-popover-item-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="cp-popover-item-copy">
        <span className="cp-popover-item-label">{label}</span>
        {description && <small>{description}</small>}
      </span>
      {selected && <Check size={20} className="cp-popover-item-end" aria-hidden="true" />}
      {submenu && <ChevronRight size={18} className="cp-popover-item-end" aria-hidden="true" />}
    </button>
  )
}
