import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import './Select.css'

/** What a change hands to `onChange`: the same `event.target.value` a native select gives. */
export interface SelectChangeEvent {
  target: { value: string }
  currentTarget: { value: string }
}

export interface SelectProps {
  /** Compared as text with each option's value, as a native select does. */
  value: string | number
  onChange?: (event: SelectChangeEvent) => void
  /** `<option>` elements, as for a native select, including in fragments and arrays. */
  children?: ReactNode
  disabled?: boolean
  id?: string
  className?: string
  title?: string
  style?: CSSProperties
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
}

interface SelectOption {
  value: string
  label: ReactNode
  text: string
  disabled: boolean
}

const LIST_MAX_HEIGHT = 300
const LIST_GAP = 4
const VIEWPORT_MARGIN = 8

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

/** The `<option>` elements among the children, through fragments and arrays. */
function optionsOf(children: ReactNode): SelectOption[] {
  const options: SelectOption[] = []
  const visit = (node: ReactNode): void => {
    Children.forEach(node, (child) => {
      if (!isValidElement(child)) return
      if (child.type === Fragment) {
        visit((child as ReactElement<{ children?: ReactNode }>).props.children)
        return
      }
      if (child.type !== 'option') return
      const props = (
        child as ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>
      ).props
      const text = textOf(props.children)
      options.push({
        value: props.value === undefined ? text : String(props.value),
        label: props.children,
        text,
        disabled: Boolean(props.disabled)
      })
    })
  }
  visit(children)
  return options
}

interface ListPlacement {
  top: number
  left: number
  minWidth: number
  maxHeight: number
  above: boolean
}

function placeList(trigger: HTMLElement): ListPlacement {
  const rect = trigger.getBoundingClientRect()
  const below = window.innerHeight - rect.bottom - LIST_GAP - VIEWPORT_MARGIN
  const above = rect.top - LIST_GAP - VIEWPORT_MARGIN
  // Open downward unless the list fits better above.
  const openAbove = below < Math.min(LIST_MAX_HEIGHT, 180) && above > below
  const maxHeight = Math.max(120, Math.min(LIST_MAX_HEIGHT, openAbove ? above : below))
  return {
    top: openAbove ? rect.top - LIST_GAP : rect.bottom + LIST_GAP,
    left: Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - rect.width - VIEWPORT_MARGIN)
    ),
    minWidth: rect.width,
    maxHeight,
    above: openAbove
  }
}

/**
 * SideKick's dropdown, in place of the operating system's: the same children and `onChange` as a
 * native `<select>`, drawn in the app's style. The list opens in a layer above everything, so a
 * scrolling panel or a dialog never clips it, and focus stays on the button while the arrow keys,
 * Enter, Escape and typing move through it.
 */
export function Select({
  value,
  onChange,
  children,
  disabled = false,
  id,
  className = '',
  title,
  style,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy
}: SelectProps): React.JSX.Element {
  const options = optionsOf(children)
  const current = String(value)
  const selectedIndex = options.findIndex((option) => option.value === current)
  // Like a native select, an unknown value shows the first option.
  const shown = options[selectedIndex >= 0 ? selectedIndex : 0]
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [placement, setPlacement] = useState<ListPlacement | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ text: '', at: 0 })
  const listId = useId()

  const close = useCallback((refocus = true): void => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }, [])

  const choose = (index: number): void => {
    const option = options[index]
    if (!option || option.disabled) return
    close()
    if (option.value !== current) {
      const target = { value: option.value }
      onChange?.({ target, currentTarget: target })
    }
  }

  const openList = (): void => {
    if (disabled || !triggerRef.current) return
    setPlacement(placeList(triggerRef.current))
    setActive(selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled))
    setOpen(true)
  }

  const step = (from: number, direction: 1 | -1): number => {
    for (let index = from + direction; index >= 0 && index < options.length; index += direction)
      if (!options[index].disabled) return index
    return from
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        openList()
      }
      return
    }
    const handled = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    switch (event.key) {
      case 'ArrowDown':
        handled()
        setActive((current) => step(current, 1))
        return
      case 'ArrowUp':
        handled()
        setActive((current) => step(current, -1))
        return
      case 'Home':
        handled()
        setActive(step(-1, 1))
        return
      case 'End':
        handled()
        setActive(step(options.length, -1))
        return
      case 'Enter':
      case ' ':
        handled()
        choose(active)
        return
      case 'Escape':
        handled()
        close()
        return
      case 'Tab':
        close(false)
        return
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Typing jumps to the next option starting with what was typed in the last moment.
      const now = Date.now()
      const text =
        (now - typeahead.current.at < 700 ? typeahead.current.text : '') + event.key.toLowerCase()
      typeahead.current = { text, at: now }
      const match = options.findIndex(
        (option) => !option.disabled && option.text.toLowerCase().startsWith(text)
      )
      if (match >= 0) setActive(match)
      handled()
    }
  }

  // Close when the user clicks elsewhere, scrolls the page under the list, or resizes the window.
  useEffect(() => {
    if (!open || !placement) return
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return
      close(false)
    }
    const scrolled = (event: Event): void => {
      if (listRef.current?.contains(event.target as Node) || !triggerRef.current) return
      // A scroll event arrives a frame late, so the one from scrolling the button into view to
      // open it can land after the list opened. Close only once the button has really moved.
      const moved = placeList(triggerRef.current)
      if (Math.abs(moved.top - placement.top) < 1 && Math.abs(moved.left - placement.left) < 1)
        return
      close(false)
    }
    const resized = (): void => close(false)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', scrolled, true)
    window.addEventListener('resize', resized)
    window.addEventListener('blur', resized)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('scroll', scrolled, true)
      window.removeEventListener('resize', resized)
      window.removeEventListener('blur', resized)
    }
  }, [open, placement, close])

  // Keep the active option in view as the keys move through a long list.
  useLayoutEffect(() => {
    if (!open || active < 0) return
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    if (typeof option?.scrollIntoView === 'function') option.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const optionId = (index: number): string => `${listId}-option-${index}`

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={`ui-select ${className}`.trim()}
        style={style}
        title={title}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        data-value={current}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
      >
        <span className="ui-select-value">{shown?.label ?? ''}</span>
        <ChevronDown size={13} className="ui-select-chevron" aria-hidden="true" />
      </button>
      {open &&
        placement &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            aria-labelledby={ariaLabel ? undefined : ariaLabelledBy}
            className={`ui-select-list${placement.above ? ' is-above' : ''}`}
            style={{
              left: placement.left,
              minWidth: placement.minWidth,
              maxHeight: placement.maxHeight,
              ...(placement.above
                ? { bottom: window.innerHeight - placement.top }
                : { top: placement.top })
            }}
            // The button keeps focus; a click on the list must not take it away.
            onMouseDown={(event) => event.preventDefault()}
          >
            {options.map((option, index) => (
              <div
                key={`${option.value}-${index}`}
                id={optionId(index)}
                data-index={index}
                data-value={option.value}
                role="option"
                aria-selected={index === selectedIndex}
                aria-disabled={option.disabled || undefined}
                className={`ui-select-option${index === active ? ' is-active' : ''}${
                  index === selectedIndex ? ' is-selected' : ''
                }`}
                onPointerMove={() => !option.disabled && setActive(index)}
                onClick={() => choose(index)}
              >
                <span className="ui-select-option-label">{option.label}</span>
                {index === selectedIndex && <Check size={13} aria-hidden="true" />}
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
