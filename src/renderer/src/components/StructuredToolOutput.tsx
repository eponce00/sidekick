import { useMemo, useState } from 'react'
import Anser from 'anser'
import { ChevronRight, ExternalLink, FileCode2, Image as ImageIcon } from 'lucide-react'

function normalizedTerminalText(value: string): string {
  return value
    .split('\n')
    .map((line) => line.split('\r').at(-1) ?? '')
    .join('\n')
}

export function AnsiTerminalOutput({ value }: { value: string }): React.JSX.Element {
  const spans = useMemo(() => Anser.ansiToJson(normalizedTerminalText(value)), [value])
  return (
    <pre className="structured-terminal-output">
      {spans.map((span, index) => (
        <span
          key={`${index}:${span.content.length}`}
          style={{
            ...(span.fg_truecolor || span.fg ? { color: span.fg_truecolor || span.fg } : {}),
            ...(span.bg_truecolor || span.bg
              ? { backgroundColor: span.bg_truecolor || span.bg }
              : {}),
            ...(span.decorations.includes('bold') ? { fontWeight: 700 } : {}),
            ...(span.decorations.includes('italic') ? { fontStyle: 'italic' } : {}),
            ...(span.decorations.includes('underline') ? { textDecoration: 'underline' } : {}),
            ...(span.decorations.includes('dim') ? { opacity: 0.7 } : {})
          }}
        >
          {span.content}
        </span>
      ))}
    </pre>
  )
}

function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }): React.JSX.Element {
  const compound = value !== null && typeof value === 'object'
  const [open, setOpen] = useState(depth < 2)
  if (!compound) {
    return (
      <div className="json-tree-row">
        {name !== undefined && <span className="json-tree-key">{name}: </span>}
        <span className={`json-tree-value is-${value === null ? 'null' : typeof value}`}>
          {typeof value === 'string' ? JSON.stringify(value) : String(value)}
        </span>
      </div>
    )
  }
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>)
  return (
    <div className="json-tree-node">
      <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <ChevronRight size={11} className={open ? 'expanded' : ''} />
        {name !== undefined && <span className="json-tree-key">{name}: </span>}
        <span>{Array.isArray(value) ? `Array(${entries.length})` : `{${entries.length}}`}</span>
      </button>
      {open && (
        <div className="json-tree-children">
          {entries.map(([key, child]) => <JsonNode key={key} name={key} value={child} depth={depth + 1} />)}
        </div>
      )}
    </div>
  )
}

export function JsonTreeView({ value }: { value: unknown }): React.JSX.Element {
  return <div className="json-tree"><JsonNode value={value} depth={0} /></div>
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export function SearchResultsOutput({ data }: { data: unknown }): React.JSX.Element | null {
  if (!data || typeof data !== 'object') return null
  const results = Array.isArray((data as Record<string, unknown>).results)
    ? ((data as Record<string, unknown>).results as Array<Record<string, unknown>>)
    : []
  if (!results.length) return null
  const imageResults = results.filter((result) => safeHttpUrl(result.thumbnailUrl || result.imageUrl))
  if (imageResults.length) {
    return (
      <div className="structured-image-results">
        {imageResults.slice(0, 8).map((result, index) => {
          const image = safeHttpUrl(result.thumbnailUrl || result.imageUrl)!
          const page = safeHttpUrl(result.pageUrl) || image
          return (
            <a key={`${page}:${index}`} href={page} target="_blank" rel="noreferrer">
              <img src={image} alt={String(result.title || 'Search result')} loading="lazy" />
              <span><ImageIcon size={11} />{String(result.title || result.source || 'Image')}</span>
            </a>
          )
        })}
      </div>
    )
  }
  return (
    <div className="structured-search-results">
      {results.slice(0, 10).map((result, index) => {
        const href = safeHttpUrl(result.url)
        if (!href) return null
        return (
          <a key={`${href}:${index}`} href={href} target="_blank" rel="noreferrer">
            <span className="structured-search-index">{index + 1}</span>
            <span className="structured-search-copy">
              <strong>{String(result.title || href)}</strong>
              <small>{new URL(href).hostname.replace(/^www\./, '')}</small>
              {Boolean(result.description) && <span>{String(result.description)}</span>}
            </span>
            <ExternalLink size={12} />
          </a>
        )
      })}
    </div>
  )
}

export function WebPageOutput({ data }: { data: unknown }): React.JSX.Element | null {
  if (!data || typeof data !== 'object') return null
  const page = data as Record<string, unknown>
  const href = safeHttpUrl(page.url)
  if (!href && !page.content) return null
  return (
    <div className="structured-web-output">
      <div className="structured-web-heading">
        <div><strong>{String(page.title || page.siteName || 'Web page')}</strong>{Boolean(page.byline) && <span>{String(page.byline)}</span>}</div>
        {href && <a href={href} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Open source</a>}
      </div>
      {Boolean(page.excerpt) && <p>{String(page.excerpt)}</p>}
      {Boolean(page.content) && <pre>{String(page.content).slice(0, 12_000)}</pre>}
    </div>
  )
}

export function ReadFileOutput({
  data,
  path,
  workspaceRoot
}: {
  data: unknown
  path?: string
  workspaceRoot?: string | null
}): React.JSX.Element | null {
  if (!data || typeof data !== 'object') return null
  const result = data as Record<string, unknown>
  if (typeof result.content !== 'string') return null
  return (
    <div className="structured-read-output">
      <div className="structured-read-heading">
        <span>Lines {Number(result.startLine || 1).toLocaleString()}–{Number(result.endLine || 0).toLocaleString()} of {Number(result.totalLines || 0).toLocaleString()}</span>
        {path && workspaceRoot && (
          <button type="button" onClick={() => void window.api.workspace.openFile(path, workspaceRoot)}>
            <FileCode2 size={12} /> Open file
          </button>
        )}
      </div>
      <pre>{result.content}</pre>
    </div>
  )
}

export function FileListOutput({
  data,
  workspaceRoot
}: {
  data: unknown
  workspaceRoot?: string | null
}): React.JSX.Element | null {
  if (!data || typeof data !== 'object') return null
  const files = Array.isArray((data as Record<string, unknown>).files)
    ? ((data as Record<string, unknown>).files as unknown[]).filter((value): value is string => typeof value === 'string')
    : []
  if (!files.length) return null
  return (
    <div className="structured-file-list">
      {files.slice(0, 200).map((path) => {
        const directory = path.endsWith('/')
        return (
          <button
            key={path}
            type="button"
            onClick={() => workspaceRoot && void (directory ? window.api.workspace.openFolder(path, workspaceRoot) : window.api.workspace.openFile(path, workspaceRoot))}
            onContextMenu={(event) => {
              event.preventDefault()
              if (workspaceRoot) void window.api.workspace.showPathMenu(path, workspaceRoot, directory)
            }}
          >
            <FileCode2 size={12} /><span>{path}</span>
          </button>
        )
      })}
    </div>
  )
}
