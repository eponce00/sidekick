import './DownloadMeter.css'

/**
 * A model download's progress on the context ring's geometry: a 16px ring with a 1.5px accent
 * arc over a `--border-color` track. The arc is progress, so it is drawn only while bytes arrive;
 * pass `active={false}` for a queued, paused or failed download and only the track shows.
 */
export function DownloadMeter({
  percent,
  active,
  className
}: {
  percent: number
  active: boolean
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={`download-meter${className ? ` ${className}` : ''}`}
      style={{ '--download-progress': `${active ? percent : 0}%` } as React.CSSProperties}
      aria-hidden="true"
    />
  )
}
