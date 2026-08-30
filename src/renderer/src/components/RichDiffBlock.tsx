import { useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { ToolExecution } from '../types/chat.types'
import './ToolExecutionCard.css'

interface DiffLine {
  kind: 'header' | 'hunk' | 'add' | 'delete' | 'context'
  text: string
}

interface SplitDiffCell {
  text: string
  line?: number
  kind: DiffLine['kind']
}

interface SplitDiffRow {
  marker?: string
  left?: SplitDiffCell
  right?: SplitDiffCell
}

function splitDiffRows(diff: string): SplitDiffRow[] {
  const lines = diff.split(/\r?\n/)
  const rows: SplitDiffRow[] = []
  let oldLine = 0
  let newLine = 0
  for (let index = 0; index < lines.length;) {
    const text = lines[index]
    const hunk = text.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      rows.push({ marker: text })
      index++
      continue
    }
    if (text.startsWith('diff ') || text.startsWith('--- ') || text.startsWith('+++ ')) {
      rows.push({ marker: text })
      index++
      continue
    }
    if (text.startsWith('-')) {
      const deleted: string[] = []
      const added: string[] = []
      while (index < lines.length && lines[index].startsWith('-') && !lines[index].startsWith('--- ')) deleted.push(lines[index++])
      while (index < lines.length && lines[index].startsWith('+') && !lines[index].startsWith('+++ ')) added.push(lines[index++])
      const count = Math.max(deleted.length, added.length)
      for (let pair = 0; pair < count; pair++) {
        rows.push({
          ...(deleted[pair] !== undefined ? { left: { text: deleted[pair], line: oldLine++, kind: 'delete' } } : {}),
          ...(added[pair] !== undefined ? { right: { text: added[pair], line: newLine++, kind: 'add' } } : {})
        })
      }
      continue
    }
    if (text.startsWith('+') && !text.startsWith('+++ ')) {
      rows.push({ right: { text, line: newLine++, kind: 'add' } })
      index++
      continue
    }
    rows.push({
      left: { text, line: oldLine++, kind: 'context' },
      right: { text, line: newLine++, kind: 'context' }
    })
    index++
  }
  return rows
}

function parseUnifiedDiff(diff: string): DiffLine[] {
  return diff.split(/\r?\n/).map((text) => ({
    text,
    kind:
      text.startsWith('+++ ') || text.startsWith('--- ') || text.startsWith('diff ')
        ? 'header'
        : text.startsWith('@@')
          ? 'hunk'
          : text.startsWith('+')
            ? 'add'
            : text.startsWith('-')
              ? 'delete'
              : 'context'
  }))
}

function resultDiff(tool: ToolExecution): string {
  const data =
    tool.data && typeof tool.data === 'object' ? (tool.data as Record<string, unknown>) : null
  return typeof data?.diff === 'string' ? data.diff : tool.output || ''
}

export function RichDiffBlock({ tool }: { tool: ToolExecution }): React.JSX.Element {
  const diff = resultDiff(tool)
  const rows = useMemo(() => parseUnifiedDiff(diff), [diff])
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [view, setView] = useState<'unified' | 'split'>('unified')
  const splitRows = useMemo(() => splitDiffRows(diff), [diff])
  const maxLines = 18
  const hidden = Math.max(0, rows.length - maxLines)
  const visible =
    hidden && !expanded
      ? [
          ...rows.slice(0, 9),
          { kind: 'hunk' as const, text: `… ${hidden} lines hidden …` },
          ...rows.slice(-9)
        ]
      : rows
  const additions = rows.filter((row) => row.kind === 'add').length
  const deletions = rows.filter((row) => row.kind === 'delete').length
  const files = new Set((tool.changes || []).map((change) => change.path)).size

  return (
    <div className="rich-diff-block">
      <div className="rich-diff-toolbar">
        <div className="rich-diff-view-toggle" aria-label="Diff layout">
          <button type="button" className={view === 'unified' ? 'active' : ''} onClick={() => setView('unified')}>Unified</button>
          <button type="button" className={view === 'split' ? 'active' : ''} onClick={() => setView('split')}>Split</button>
        </div>
        <button
          type="button"
          className="rich-tool-copy"
          onClick={() => {
            void navigator.clipboard.writeText(diff).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1_000)
            })
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy diff'}
        </button>
      </div>
      {view === 'split' ? (
        <div className="rich-diff-split">
          {splitRows.map((row, index) => row.marker ? (
            <div key={`${index}-${row.marker}`} className="rich-diff-split-marker">{row.marker}</div>
          ) : (
            <div key={index} className="rich-diff-split-row">
              {[row.left, row.right].map((cell, side) => (
                <div key={side} className={`rich-diff-split-cell ${cell ? `is-${cell.kind}` : 'is-empty'}`}>
                  <span>{cell?.line ?? ''}</span><code>{cell?.text || ' '}</code>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="rich-diff-lines">
          {visible.map((row, index) => (
            <div key={`${index}-${row.text}`} className={`rich-diff-line is-${row.kind}`}>
              {row.text || ' '}
            </div>
          ))}
        </div>
      )}
      <div className="rich-diff-footer">
        <span className="diff-additions">+{additions}</span>
        <span className="diff-deletions">−{deletions}</span>
        {files > 0 && (
          <span>
            {files} {files === 1 ? 'file' : 'files'}
          </span>
        )}
        {hidden > 0 && (
          <button type="button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Collapse' : `Show ${hidden} hidden lines`}
          </button>
        )}
      </div>
    </div>
  )
}
