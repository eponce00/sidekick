import React from 'react'
import { Brain, Check } from 'lucide-react'
import {
  REASONING_LEVEL_LABELS,
  type ReasoningLevel,
  type ReasoningOptions
} from '../../../shared/reasoning'
import './ReasoningMenu.css'

const DESCRIPTIONS: Record<ReasoningLevel, string> = {
  auto: 'Leave it to the model or server',
  off: 'Answer without reasoning first',
  on: 'Reason before answering',
  minimal: 'The least reasoning that still helps',
  low: 'Quick reasoning for simple work',
  medium: 'Balanced depth and speed',
  high: 'Think hard about difficult problems',
  xhigh: 'Extended reasoning, slower and costlier',
  max: 'As much reasoning as the model allows'
}

/** What the button says: short, since it sits in the composer toolbar. */
const BUTTON_LABELS: Partial<Record<ReasoningLevel, string>> = { auto: 'Auto', xhigh: 'X-High' }

function reasoningButtonLabel(level: ReasoningLevel): string {
  return BUTTON_LABELS[level] ?? REASONING_LEVEL_LABELS[level]
}

/**
 * The reasoning control for the selected model. It lists only the levels that model's protocol
 * and server can carry, so a model with on/off shows two and an effort model shows its scale.
 */
export function ReasoningMenu({
  options,
  level,
  onChange
}: {
  options: ReasoningOptions
  level: ReasoningLevel
  onChange: (level: ReasoningLevel) => void
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])

  const active = level !== 'off'
  return (
    <div className="reasoning-menu-container" ref={containerRef}>
      <button
        type="button"
        className={`composer-reasoning-button${active ? ' is-on' : ''}`}
        onClick={() => setOpen(!open)}
        aria-label={`Reasoning: ${REASONING_LEVEL_LABELS[level]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Reasoning: ${REASONING_LEVEL_LABELS[level]}. ${DESCRIPTIONS[level]}.`}
      >
        <Brain size={15} strokeWidth={1.9} aria-hidden="true" />
        <span>{reasoningButtonLabel(level)}</span>
      </button>
      {open && (
        <div className="features-menu reasoning-menu" role="menu" aria-label="Reasoning level">
          <div className="reasoning-menu-title">Reasoning</div>
          {options.levels.map((option) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={option === level}
              key={option}
              className={`reasoning-menu-option${option === level ? ' is-selected' : ''}`}
              onClick={() => {
                onChange(option)
                setOpen(false)
              }}
            >
              <span className="reasoning-menu-option-text">
                <span>{REASONING_LEVEL_LABELS[option]}</span>
                <small>{DESCRIPTIONS[option]}</small>
              </span>
              {option === level && <Check size={13} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
