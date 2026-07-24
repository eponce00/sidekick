import { useState, useEffect, useRef } from 'react'
import { X } from 'lucide-react'

/**
 * Searchable combobox for selecting a model from a list of available models.
 * Supports typing to filter, clicking to select, and clearing the value.
 */
export function ModelCombobox({
  id,
  value,
  onChange,
  models,
  loading,
  placeholder
}: {
  id: string
  value: string
  onChange: (value: string | undefined) => void
  models: string[]
  loading: boolean
  placeholder: string
}): React.JSX.Element {
  const [query, setQuery] = useState(value)
  const [isOpen, setIsOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setQuery(value)
  }, [value])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const filtered = query
    ? models.filter((m) => m.toLowerCase().includes(query.toLowerCase()))
    : models

  return (
    <div className="model-combobox" ref={wrapperRef}>
      <div className="model-combobox-input-wrap">
        <input
          id={id}
          type="text"
          placeholder={loading ? 'Loading models...' : placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            onChange(e.target.value || undefined)
            setIsOpen(true)
          }}
          onFocus={() => setIsOpen(true)}
          autoComplete="off"
        />
        {value && (
          <button
            className="model-combobox-clear"
            onClick={() => {
              setQuery('')
              onChange(undefined)
              setIsOpen(false)
            }}
            title="Clear"
            type="button"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {isOpen && filtered.length > 0 && (
        <ul className="model-combobox-list">
          {filtered.slice(0, 20).map((m) => (
            <li
              key={m}
              className={`model-combobox-option ${m === value ? 'selected' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                setQuery(m)
                onChange(m)
                setIsOpen(false)
              }}
            >
              {m}
            </li>
          ))}
          {filtered.length > 20 && (
            <li className="model-combobox-more">
              {filtered.length - 20} more — keep typing to narrow
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
