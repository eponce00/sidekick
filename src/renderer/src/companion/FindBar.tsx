import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { findRanges } from './chatFind'
import { useBackLayer } from './navigation'

type HighlightRegistry = Map<string, unknown>
type HighlightClass = new (...ranges: Range[]) => unknown

function highlights(): { registry: HighlightRegistry; Highlight: HighlightClass } | null {
  const scope = globalThis as {
    CSS?: { highlights?: HighlightRegistry }
    Highlight?: HighlightClass
  }
  return scope.CSS?.highlights && scope.Highlight
    ? { registry: scope.CSS.highlights, Highlight: scope.Highlight }
    : null
}

/**
 * Find in chat, in place of the top bar: the words are marked where they show, and the arrows
 * step from one to the next, scrolling to it.
 */
export function FindBar({
  containerRef,
  onClose
}: {
  containerRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Range[]>([])
  const [current, setCurrent] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useBackLayer(true, onClose)
  useEffect(() => input.current?.focus(), [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const container = containerRef.current
      setMatches(container ? findRanges(container, query) : [])
      setCurrent(0)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [containerRef, query])

  // The marks, and the current one brought into view.
  useEffect(() => {
    const api = highlights()
    if (api) {
      api.registry.set('cp-find', new api.Highlight(...matches))
      api.registry.set('cp-find-current', new api.Highlight(...matches.slice(current, current + 1)))
    }
    const range = matches[current]
    const container = containerRef.current
    if (range && container) {
      const box = range.getBoundingClientRect()
      const frame = container.getBoundingClientRect()
      if (box.top < frame.top + 80 || box.bottom > frame.bottom - 40)
        container.scrollBy({
          top: box.top - frame.top - frame.height / 3,
          behavior: 'smooth'
        })
    }
  }, [matches, current, containerRef])

  useEffect(
    () => () => {
      const api = highlights()
      api?.registry.delete('cp-find')
      api?.registry.delete('cp-find-current')
    },
    []
  )

  const step = (by: number): void => {
    if (!matches.length) return
    setCurrent((index) => (index + by + matches.length) % matches.length)
  }

  return (
    <div className="cp-find" role="search">
      <label className="cp-find-field">
        <Search size={17} aria-hidden="true" />
        <input
          ref={input}
          type="search"
          value={query}
          placeholder="Find in chat"
          aria-label="Find in chat"
          enterKeyHint="search"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              step(event.shiftKey ? -1 : 1)
            } else if (event.key === 'Escape') onClose()
          }}
        />
        {query.trim() && (
          <span className="cp-find-count" aria-live="polite">
            {matches.length ? `${current + 1}/${matches.length}` : '0'}
          </span>
        )}
      </label>
      <button
        type="button"
        className="cp-icon-button"
        aria-label="Previous match"
        disabled={!matches.length}
        onClick={() => step(-1)}
      >
        <ChevronUp size={20} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="cp-icon-button"
        aria-label="Next match"
        disabled={!matches.length}
        onClick={() => step(1)}
      >
        <ChevronDown size={20} aria-hidden="true" />
      </button>
      <button type="button" className="cp-icon-button" aria-label="Close find" onClick={onClose}>
        <X size={20} aria-hidden="true" />
      </button>
    </div>
  )
}
