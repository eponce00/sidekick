import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { FolderOpen, MessageSquare, Search, Zap } from 'lucide-react'
import { useModalDialog } from '../hooks/useModalDialog'
import {
  filterCommandPalette,
  nextEnabledIndex,
  type CommandPaletteGroupId,
  type CommandPaletteItem
} from '../utils/commandPalette'
import './CommandPalette.css'

interface CommandPaletteProps {
  isOpen: boolean
  items: CommandPaletteItem[]
  onClose: () => void
}

const GROUP_ICONS: Record<CommandPaletteGroupId, typeof Zap> = {
  actions: Zap,
  conversations: MessageSquare,
  projects: FolderOpen
}

function CommandPaletteDialog({
  items,
  onClose
}: Omit<CommandPaletteProps, 'isOpen'>): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const dialogRef = useModalDialog<HTMLDivElement>(true, onClose)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const optionId = useId()
  const sections = useMemo(() => filterCommandPalette(items, query), [items, query])
  const rows = useMemo(() => sections.flatMap((section) => section.items), [sections])
  const selected =
    rows[activeIndex] && !rows[activeIndex].disabled ? activeIndex : nextEnabledIndex(rows, -1, 1)

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  const choose = (item: CommandPaletteItem | undefined): void => {
    if (!item || item.disabled) return
    onClose()
    item.run()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = nextEnabledIndex(rows, selected, event.key === 'ArrowDown' ? 1 : -1)
      if (next !== -1) setActiveIndex(next)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(rows[selected])
    }
  }

  return (
    <div className="command-palette-overlay" role="presentation" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <label className="command-palette-search">
          <Search size={15} aria-hidden="true" />
          <input
            autoFocus
            value={query}
            placeholder="Search conversations, projects and actions"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={selected >= 0 ? `${optionId}-${selected}` : undefined}
            aria-label="Search conversations, projects and actions"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleKeyDown}
          />
        </label>
        <div ref={listRef} id={listId} className="command-palette-list" role="listbox">
          {sections.length === 0 && <div className="command-palette-empty">No matches</div>}
          {sections.map((section, sectionIndex) => {
            const Icon = GROUP_ICONS[section.id]
            const start = sections
              .slice(0, sectionIndex)
              .reduce((count, previous) => count + previous.items.length, 0)
            return (
              <div key={section.id} role="group" aria-label={section.label}>
                <div className="command-palette-group-label" aria-hidden="true">
                  {section.label}
                </div>
                {section.items.map((item, itemIndex) => {
                  const index = start + itemIndex
                  return (
                    <div
                      key={item.id}
                      id={`${optionId}-${index}`}
                      className="command-palette-option"
                      role="option"
                      aria-selected={index === selected}
                      aria-disabled={item.disabled || undefined}
                      onMouseMove={() => {
                        if (!item.disabled && index !== selected) setActiveIndex(index)
                      }}
                      onClick={() => choose(item)}
                    >
                      <Icon size={14} className="command-palette-icon" aria-hidden="true" />
                      <span className="command-palette-title">{item.title}</span>
                      {item.detail && <span className="command-palette-detail">{item.detail}</span>}
                      {item.shortcut && (
                        <kbd className="command-palette-shortcut">{item.shortcut}</kbd>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
        <div className="command-palette-footer" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to open
          </span>
          <span>
            <kbd>Esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  )
}

/** Keyboard-first search over conversations, projects and app actions. */
function CommandPalette({ isOpen, items, onClose }: CommandPaletteProps): React.JSX.Element | null {
  // Mounting on open gives every opening an empty query and the first row selected.
  return isOpen ? <CommandPaletteDialog items={items} onClose={onClose} /> : null
}

export default CommandPalette
