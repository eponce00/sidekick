import { nextActivityPanelSize, type ActivityPanelSize } from '../utils/activityPanelLayout'

const SIZE_NAMES: Record<ActivityPanelSize, string> = {
  narrow: 'narrow',
  wide: 'wide (drag its edge to size it)',
  full: 'full window, chat hidden'
}

/** How far the panel's fill reaches into the window outline, from the right. */
const FILL_X: Record<ActivityPanelSize, number> = { narrow: 10, wide: 7, full: 3.5 }

/**
 * A window outline with the panel's share of it filled from the right: a sliver, about half, or
 * all of it but the sidebar's rail.
 */
export function PanelSizeIcon({ size }: { size: ActivityPanelSize }): React.JSX.Element {
  const x = FILL_X[size]
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="1.25"
        y="2.25"
        width="13.5"
        height="11.5"
        rx="2.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect x={x} y="4.25" width={12.75 - x} height="7.5" rx="1" fill="currentColor" />
    </svg>
  )
}

/**
 * One button for the inspector's size: it shows the size the panel is, and each click steps to
 * the next one.
 */
export function ActivityPanelSizeButton({
  size,
  onChange
}: {
  size: ActivityPanelSize
  onChange: (size: ActivityPanelSize) => void
}): React.JSX.Element {
  const next = nextActivityPanelSize(size)
  const label = `Panel size: ${SIZE_NAMES[size]}. Click for ${SIZE_NAMES[next].split(' (')[0]}.`
  return (
    <button
      type="button"
      className="activity-panel-toggle activity-size-button"
      data-size={size}
      onClick={() => onChange(next)}
      title={label}
      aria-label={label}
    >
      <PanelSizeIcon size={size} />
    </button>
  )
}
