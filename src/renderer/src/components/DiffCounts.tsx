import './DiffCounts.css'

/**
 * A change's "+N −N", one look wherever counts appear. A zero count is muted, so green and red
 * show only where lines were actually added or removed.
 */
export function DiffCounts({
  additions,
  deletions
}: {
  additions: number
  deletions: number
}): React.JSX.Element {
  return (
    <>
      <span className={`diff-count is-add${additions === 0 ? ' is-zero' : ''}`}>
        +{additions.toLocaleString()}
      </span>
      <span className={`diff-count is-delete${deletions === 0 ? ' is-zero' : ''}`}>
        −{deletions.toLocaleString()}
      </span>
    </>
  )
}
