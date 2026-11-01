import { Square } from 'lucide-react'

/**
 * The one stop mark: a small filled square. A hollow one at icon size reads as an unchecked
 * checkbox beside "Stop".
 */
export function StopGlyph({ size = 10 }: { size?: number }): React.JSX.Element {
  return <Square size={size} fill="currentColor" aria-hidden="true" />
}
