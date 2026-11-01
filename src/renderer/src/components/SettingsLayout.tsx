import type { ReactNode } from 'react'
import { Check, type LucideIcon } from 'lucide-react'

/**
 * Building blocks every Settings page shares, so a new section or row looks like the rest:
 * a page heading, sections with an icon and description, and rows with the label and its
 * description on the left and the control on the right.
 */

export function SettingsPageHeader({
  title,
  description,
  actions
}: {
  title: string
  description?: string
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <header className="settings-page-heading">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="settings-page-actions">{actions}</div>}
    </header>
  )
}

export function SettingsSection({
  id,
  icon: Icon,
  title,
  description,
  actions,
  className,
  children
}: {
  id?: string
  icon?: LucideIcon
  title: string
  description?: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className={`settings-card${className ? ` ${className}` : ''}`} id={id}>
      <div className="settings-card-heading">
        {Icon && (
          <span className="settings-card-icon" aria-hidden="true">
            <Icon size={16} />
          </span>
        )}
        <div className="settings-card-title">
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="settings-card-actions">{actions}</div>}
      </div>
      <div className="settings-card-content">{children}</div>
    </section>
  )
}

/**
 * One setting: label and description on the left, its control on the right. `stacked` puts the
 * control under the label for wide inputs; `children` add detail under the whole row, such as a
 * level meter. Pass `controlId` when the control is a single input so the label focuses it.
 */
export function SettingsRow({
  icon: Icon,
  label,
  description,
  controlId,
  control,
  stacked,
  disabled,
  className,
  children
}: {
  icon?: LucideIcon
  label: ReactNode
  description?: ReactNode
  controlId?: string
  control?: ReactNode
  stacked?: boolean
  disabled?: boolean
  className?: string
  children?: ReactNode
}): React.JSX.Element {
  const classes = ['settings-row']
  if (Icon) classes.push('has-icon')
  if (stacked) classes.push('stacked')
  if (disabled) classes.push('disabled')
  if (className) classes.push(className)
  return (
    <div className={classes.join(' ')}>
      {Icon && (
        <span className="settings-row-icon" aria-hidden="true">
          <Icon size={16} />
        </span>
      )}
      <div className="settings-row-copy">
        {controlId ? (
          <label className="settings-row-label" htmlFor={controlId}>
            {label}
          </label>
        ) : (
          <span className="settings-row-label">{label}</span>
        )}
        {description && <span className="settings-row-description">{description}</span>}
      </div>
      {control && <div className="settings-row-control">{control}</div>}
      {children && <div className="settings-row-detail">{children}</div>}
    </div>
  )
}

/** A switch row. The whole row is the label, so clicking anywhere on it toggles. */
export function ToggleField({
  icon: Icon,
  label,
  hint,
  checked,
  disabled,
  onChange
}: {
  icon?: LucideIcon
  label: string
  hint?: ReactNode
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  const classes = ['settings-row', 'settings-toggle-row']
  if (Icon) classes.push('has-icon')
  if (disabled) classes.push('disabled')
  return (
    <label className={classes.join(' ')}>
      {Icon && (
        <span className="settings-row-icon" aria-hidden="true">
          <Icon size={16} />
        </span>
      )}
      <span className="settings-row-copy">
        <strong className="settings-row-label">{label}</strong>
        {hint && <small className="settings-row-description">{hint}</small>}
      </span>
      <span className="settings-row-control">
        <SettingsSwitch checked={checked} disabled={disabled} onChange={onChange} />
      </span>
    </label>
  )
}

/** The switch itself, for rows that need it outside a `ToggleField`. */
export function SettingsSwitch({
  checked,
  disabled,
  label,
  onChange
}: {
  checked: boolean
  disabled?: boolean
  label?: string
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <span className="modern-switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span />
    </span>
  )
}

/**
 * The app's one checkbox: a 16px box drawn over a visually hidden native input, which keeps the
 * keyboard, form and `<label>` behaviour, and reaches 4px past the box so the hit target is 24px
 * without taking more room in a row.
 */
export function Checkbox({
  checked,
  disabled,
  id,
  label,
  className,
  onChange
}: {
  checked: boolean
  disabled?: boolean
  id?: string
  /** The accessible name, when no `<label>` names the box. */
  label?: string
  className?: string
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <span className={className ? `ui-checkbox ${className}` : 'ui-checkbox'}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="ui-checkbox-box" aria-hidden="true">
        <Check size={12} strokeWidth={2.5} />
      </span>
    </span>
  )
}

export function SettingsEmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact,
  centered
}: {
  icon: LucideIcon
  title: string
  description?: ReactNode
  action?: ReactNode
  compact?: boolean
  /** Stacked and centred with its description showing, for an empty panel rather than a row. */
  centered?: boolean
}): React.JSX.Element {
  return (
    <div className={`settings-empty${compact ? ' compact' : ''}${centered ? ' centered' : ''}`}>
      <span className="settings-empty-icon" aria-hidden="true">
        <Icon size={centered ? 18 : compact ? 16 : 20} />
      </span>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action}
    </div>
  )
}
