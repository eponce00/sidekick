import { useMemo } from 'react'
import { SiteIcon } from './SiteIcon'
import { extractMessageSources } from '../utils/messageSources'

const VISIBLE_SOURCES = 6

/**
 * A compact "Sources" row under a reply: one chip per site the reply linked,
 * in order of first mention. Clicking opens the link like any other.
 */
export function MessageSources({ content }: { content: string }): React.JSX.Element | null {
  const sources = useMemo(() => extractMessageSources(content), [content])
  if (sources.length === 0) return null
  const visible = sources.slice(0, VISIBLE_SOURCES)
  const hidden = sources.length - visible.length
  return (
    <div className="message-sources" aria-label="Sources">
      <span className="message-sources-label">Sources</span>
      {visible.map((source) => (
        <a
          key={source.host}
          className="message-source-chip"
          href={source.url}
          target="_blank"
          rel="noreferrer"
          title={source.label ? `${source.label} — ${source.url}` : source.url}
        >
          <SiteIcon url={source.url} size={14} />
          <span className="message-source-host">{source.host}</span>
        </a>
      ))}
      {hidden > 0 && <span className="message-sources-more">+{hidden}</span>}
    </div>
  )
}
