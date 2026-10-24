import React from 'react'
import { REASONING_LEVEL_LABELS, type ReasoningLevel } from '../../../shared/reasoning'
import { effortStops } from '../utils/effortStops'
import './EffortSlider.css'

/**
 * How hard the model thinks, as a slider with a stop for each level the model offers: drag it,
 * tap a stop, or use the arrow keys. "Model default" has no stop; the slider then sits empty.
 */
export function EffortSlider({
  levels,
  level,
  onChange
}: {
  levels: readonly ReasoningLevel[]
  level: ReasoningLevel
  onChange: (level: ReasoningLevel) => void
}): React.JSX.Element | null {
  const stops = effortStops(levels)
  const track = React.useRef<HTMLDivElement>(null)
  const dragging = React.useRef(false)
  const index = stops.indexOf(level)
  if (stops.length < 2) return null
  const last = stops.length - 1
  // The fill and thumb sit on the stop; with no stop chosen, at the start and empty.
  const at = index < 0 ? 0 : index / last

  const stopAt = (clientX: number): ReasoningLevel => {
    const box = track.current?.getBoundingClientRect()
    if (!box?.width) return stops[Math.max(0, index)]
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width))
    return stops[Math.round(ratio * last)]
  }
  const pick = (next: ReasoningLevel): void => {
    if (next !== level) onChange(next)
  }

  return (
    <div
      ref={track}
      className="effort-slider"
      role="slider"
      tabIndex={0}
      aria-label="Reasoning effort"
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={Math.max(0, index)}
      aria-valuetext={REASONING_LEVEL_LABELS[level]}
      style={{ '--effort-at': at } as React.CSSProperties}
      onPointerDown={(event) => {
        dragging.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
        pick(stopAt(event.clientX))
      }}
      onPointerMove={(event) => {
        if (dragging.current) pick(stopAt(event.clientX))
      }}
      onPointerUp={() => {
        dragging.current = false
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
      onKeyDown={(event) => {
        const step =
          event.key === 'ArrowRight' || event.key === 'ArrowUp'
            ? 1
            : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
              ? -1
              : 0
        if (event.key === 'Home') pick(stops[0])
        else if (event.key === 'End') pick(stops[last])
        else if (step) pick(stops[Math.min(last, Math.max(0, (index < 0 ? -1 : index) + step))])
        else return
        event.preventDefault()
      }}
    >
      <span className="effort-slider-fill" aria-hidden="true" />
      {stops.map((stop, stopIndex) => (
        <span
          key={stop}
          className={`effort-slider-stop${stopIndex <= index ? ' is-passed' : ''}`}
          style={{ left: `calc(var(--effort-inset) + ${stopIndex / last} * var(--effort-span))` }}
          aria-hidden="true"
        />
      ))}
      {index >= 0 && <span className="effort-slider-thumb" aria-hidden="true" />}
    </div>
  )
}
