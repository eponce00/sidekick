import { Minus, Plus, RotateCcw } from 'lucide-react'
import type {
  AnnotationStyleProperty,
  AnnotationStyleValues
} from '../../../shared/annotationOverlay'

const FONTS = [
  { label: 'As it is', value: '' },
  { label: 'System', value: 'system-ui, sans-serif' },
  { label: 'Inter', value: 'Inter, sans-serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: "'Times New Roman', serif" },
  { label: 'Courier New', value: "'Courier New', monospace" }
]

const WEIGHTS = ['300', '400', '500', '600', '700', '800']

/** A computed color as the hex a color field takes; transparent has none. */
function hexColor(value: string | undefined): string | null {
  const match = value?.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?/)
  if (!match) return /^#[0-9a-f]{6}$/i.test(value ?? '') ? value!.toLowerCase() : null
  const alpha =
    match[4] === undefined ? 1 : Number.parseFloat(match[4]) / (match[4].endsWith('%') ? 100 : 1)
  if (alpha === 0) return null
  return `#${[match[1], match[2], match[3]]
    .map((part) => Number(part).toString(16).padStart(2, '0'))
    .join('')}`
}

/**
 * Changes a marked element's look live on the page: text size, weight, font, colors and opacity.
 * Each change is shown at once; Reset puts the element back as the page had it.
 */
export function StyleEditor({
  values,
  changed,
  onChange,
  onReset
}: {
  /** The element's styles as the editor opened. */
  values: AnnotationStyleValues
  changed: AnnotationStyleValues
  onChange: (styles: AnnotationStyleValues) => void
  onReset: () => void
}): React.JSX.Element {
  const value = (property: AnnotationStyleProperty): string =>
    changed[property] ?? values[property] ?? ''
  const size = Math.round(Number.parseFloat(value('font-size')) || 16)
  const weight = String(Math.round((Number.parseInt(value('font-weight'), 10) || 400) / 100) * 100)
  const shown = Number.parseFloat(value('opacity'))
  const opacity = Math.round((Number.isFinite(shown) ? shown : 1) * 100)
  const font =
    FONTS.find((item) => item.value && changed['font-family'] === item.value)?.value ?? ''
  const setSize = (next: number): void =>
    onChange({ 'font-size': `${Math.min(160, Math.max(6, next))}px` })

  return (
    <div className="ao-style" role="group" aria-label="Style">
      <div className="ao-style-row">
        <span>Text size</span>
        <div className="ao-stepper">
          <button type="button" aria-label="Smaller text" onClick={() => setSize(size - 1)}>
            <Minus size={13} />
          </button>
          <input
            type="number"
            aria-label="Text size in pixels"
            min={6}
            max={160}
            value={size}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10)
              if (Number.isFinite(next)) setSize(next)
            }}
          />
          <button type="button" aria-label="Larger text" onClick={() => setSize(size + 1)}>
            <Plus size={13} />
          </button>
        </div>
      </div>
      <label className="ao-style-row">
        <span>Weight</span>
        <select
          value={weight}
          onChange={(event) => onChange({ 'font-weight': event.target.value })}
        >
          {WEIGHTS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>
      <label className="ao-style-row">
        <span>Font</span>
        <select value={font} onChange={(event) => onChange({ 'font-family': event.target.value })}>
          {FONTS.map((item) => (
            <option key={item.label} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <ColorRow
        label="Text color"
        value={hexColor(value('color'))}
        onChange={(color) => onChange({ color })}
      />
      <ColorRow
        label="Background"
        value={hexColor(value('background-color'))}
        onChange={(color) => onChange({ 'background-color': color })}
      />
      <label className="ao-style-row">
        <span>Opacity</span>
        <input
          type="range"
          min={0}
          max={100}
          value={opacity}
          onChange={(event) =>
            onChange({ opacity: String(Number.parseInt(event.target.value, 10) / 100) })
          }
        />
        <span className="ao-style-value">{opacity}%</span>
      </label>
      <div className="ao-style-actions">
        <button
          type="button"
          className="ao-style-reset"
          disabled={!Object.values(changed).some(Boolean)}
          onClick={onReset}
        >
          <RotateCcw size={13} aria-hidden="true" />
          Reset
        </button>
      </div>
    </div>
  )
}

function ColorRow({
  label,
  value,
  onChange
}: {
  label: string
  value: string | null
  onChange: (color: string) => void
}): React.JSX.Element {
  return (
    <label className="ao-style-row">
      <span>{label}</span>
      <span className="ao-color">
        <input
          type="color"
          value={value ?? '#ffffff'}
          onChange={(event) => onChange(event.target.value)}
        />
        <code>{value ?? 'None'}</code>
      </span>
    </label>
  )
}
