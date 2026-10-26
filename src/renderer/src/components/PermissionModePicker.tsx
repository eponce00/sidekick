import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Check, ChevronDown, ShieldCheck, ShieldOff, ShieldQuestion } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PERMISSION_MODE_LABELS, type PermissionMode } from '../../../shared/permissions'
import { useOutsideClick } from '../hooks/useOutsideClick'

const MODES: ReadonlyArray<{
  mode: PermissionMode
  chip: string
  icon: LucideIcon
  description: string
}> = [
  {
    mode: 'full-access',
    chip: 'Full access',
    icon: ShieldOff,
    description: 'Commands, files, connectors, the browser and credentials run without asking.'
  },
  {
    mode: 'sensitive-only',
    chip: 'Ask first',
    icon: ShieldCheck,
    description: 'Reading runs on its own; changes, commands and credential use ask.'
  },
  {
    mode: 'always-ask',
    chip: 'Always ask',
    icon: ShieldQuestion,
    description: 'Every change, command and credential use asks first.'
  }
]

/**
 * The permission mode, beside the model in the composer. It is the one setting Settings shows
 * too, for every chat; a change applies from the next reply.
 */
export function PermissionModePicker({
  mode,
  onChange
}: {
  mode: PermissionMode
  onChange: (mode: PermissionMode) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  useOutsideClick([containerRef], () => setOpen(false), open)
  const selectedIndex = Math.max(
    0,
    MODES.findIndex((entry) => entry.mode === mode)
  )
  const current = MODES[selectedIndex]
  const Icon = current.icon

  // The menu opens on the mode in use, ready for the arrow keys.
  useEffect(() => {
    if (open) optionRefs.current[selectedIndex]?.focus()
  }, [open, selectedIndex])

  const close = (): void => {
    setOpen(false)
    chipRef.current?.focus()
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const focused = optionRefs.current.findIndex((option) => option === document.activeElement)
    const move = (index: number): void => {
      event.preventDefault()
      optionRefs.current[(index + MODES.length) % MODES.length]?.focus()
    }
    if (event.key === 'ArrowDown') move(focused + 1)
    else if (event.key === 'ArrowUp') move(focused - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(MODES.length - 1)
    else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  return (
    <div className="permission-menu-container" ref={containerRef}>
      <button
        ref={chipRef}
        type="button"
        className={`permission-selector-inline is-${current.mode}`}
        onClick={(event) => {
          event.stopPropagation()
          setOpen(!open)
        }}
        title={`Permissions: ${PERMISSION_MODE_LABELS[current.mode]}`}
        aria-label={`Permissions: ${PERMISSION_MODE_LABELS[current.mode]}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon size={13} aria-hidden="true" />
        <span className="permission-selector-inline-label">{current.chip}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="features-menu permission-menu"
          role="menu"
          aria-label="Permissions"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={onMenuKeyDown}
        >
          <div className="permission-menu-heading" aria-hidden="true">
            Permissions
          </div>
          {MODES.map((entry, index) => {
            const EntryIcon = entry.icon
            const selected = entry.mode === mode
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                key={entry.mode}
                ref={(element) => {
                  optionRefs.current[index] = element
                }}
                className={`permission-menu-option is-${entry.mode} ${selected ? 'is-selected' : ''}`}
                onClick={() => {
                  close()
                  if (!selected) onChange(entry.mode)
                }}
              >
                <span className="permission-menu-option-icon">
                  <EntryIcon size={14} aria-hidden="true" />
                </span>
                <span className="permission-menu-option-text">
                  <strong>{PERMISSION_MODE_LABELS[entry.mode]}</strong>
                  <small>{entry.description}</small>
                </span>
                {selected && <Check size={14} className="permission-menu-option-check" />}
              </button>
            )
          })}
          <div className="permission-menu-footer">For every chat, from the next reply</div>
        </div>
      )}
    </div>
  )
}
