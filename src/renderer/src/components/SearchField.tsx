import { Search } from 'lucide-react'
import type { InputHTMLAttributes, ReactNode, Ref } from 'react'
import './SearchField.css'

type SearchFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'onChange'> & {
  value: string
  onChange: (value: string) => void
  /** `chrome` (30px) for the sidebar and navigation; `form` (32px) inside a settings page. */
  size?: 'chrome' | 'form'
  /** Classes for the field's container, for its placement. */
  className?: string
  /** Drawn after the input, such as a clear button. */
  trailing?: ReactNode
  iconSize?: number
  ref?: Ref<HTMLInputElement>
}

/**
 * The one search field: a quiet fill with no border, a search glyph, and the input. Every list
 * that can be searched (the sidebar, the Settings navigation, a provider's models) uses it.
 */
export function SearchField({
  value,
  onChange,
  size = 'chrome',
  className,
  trailing,
  iconSize = 14,
  ref,
  ...inputProps
}: SearchFieldProps): React.JSX.Element {
  return (
    <label className={`search-field is-${size}${className ? ` ${className}` : ''}`}>
      <Search size={iconSize} aria-hidden="true" />
      <input
        {...inputProps}
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {trailing}
    </label>
  )
}
