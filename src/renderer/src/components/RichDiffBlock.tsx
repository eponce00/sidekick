import { Fragment, useMemo, useState } from 'react'
import { Check, Copy, MessageSquarePlus } from 'lucide-react'
import type { ToolExecution } from '../types/chat.types'
import {
  isCommentableDiffRow,
  parseDiffRows,
  selectDiffLines,
  splitDiffRows,
  type DiffLineSelection,
  type DiffRow
} from '../utils/diffRows'
import './ToolExecutionCard.css'

function resultDiff(tool: ToolExecution): string {
  const data =
    tool.data && typeof tool.data === 'object' ? (tool.data as Record<string, unknown>) : null
  return typeof data?.diff === 'string' ? data.diff : tool.output || ''
}

/** The collapsed view's placeholder is a row that belongs to no line. */
type VisibleDiffRow = Pick<DiffRow, 'kind' | 'text'> &
  Partial<Pick<DiffRow, 'index' | 'oldLine' | 'newLine'>>

function selectionLabel(selection: DiffLineSelection): string {
  const lines =
    selection.startLine === selection.endLine
      ? `Line ${selection.startLine}`
      : `Lines ${selection.startLine}–${selection.endLine}`
  return selection.side === 'old' ? `${lines} (removed)` : lines
}

interface DiffCommentFormProps {
  selection: DiffLineSelection
  onSubmit: (comment: string) => boolean
  onCancel: () => void
}

function DiffCommentForm({
  selection,
  onSubmit,
  onCancel
}: DiffCommentFormProps): React.JSX.Element {
  const [comment, setComment] = useState('')
  const submit = (): void => {
    if (comment.trim() && onSubmit(comment)) setComment('')
  }
  return (
    <div className="rich-diff-comment-form" role="group" aria-label="Comment on selected lines">
      <span className="rich-diff-comment-range">{selectionLabel(selection)}</span>
      <textarea
        autoFocus
        rows={2}
        value={comment}
        placeholder="Comment for the agent… (Ctrl+Enter to add)"
        aria-label={`Comment on ${selectionLabel(selection).toLowerCase()}`}
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <div className="rich-diff-comment-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="is-primary" disabled={!comment.trim()} onClick={submit}>
          Add to message
        </button>
      </div>
    </div>
  )
}

export function RichDiffBlock({
  tool,
  onAddComment
}: {
  tool: ToolExecution
  /** Given, lines can be selected by their number and commented on. */
  onAddComment?: (selection: DiffLineSelection, comment: string) => boolean
}): React.JSX.Element {
  const diff = resultDiff(tool)
  const rows = useMemo(() => parseDiffRows(diff), [diff])
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [view, setView] = useState<'unified' | 'split'>('unified')
  const splitRows = useMemo(() => splitDiffRows(rows), [rows])
  const [range, setRange] = useState<{ anchor: number; focus: number } | null>(null)
  const selection = range && onAddComment ? selectDiffLines(rows, range.anchor, range.focus) : null
  const selectedFrom = range ? Math.min(range.anchor, range.focus) : -1
  const selectedTo = range ? Math.max(range.anchor, range.focus) : -1
  const isSelected = (index: number): boolean => index >= selectedFrom && index <= selectedTo
  const maxLines = 18
  const hidden = Math.max(0, rows.length - maxLines)
  const visible: VisibleDiffRow[] =
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

  const selectLine = (index: number, extend: boolean): void => {
    setRange((current) => {
      if (extend && current) return { anchor: current.anchor, focus: index }
      if (current && current.anchor === index && current.focus === index) return null
      return { anchor: index, focus: index }
    })
  }

  const lineButton = (index: number, line: number | undefined): React.JSX.Element | null => {
    if (!onAddComment || line === undefined) return null
    return (
      <button
        type="button"
        className="rich-diff-line-number"
        aria-pressed={isSelected(index)}
        title="Comment on this line · Shift-click to select a range"
        aria-label={`Select line ${line} to comment`}
        onClick={(event) => selectLine(index, event.shiftKey)}
      >
        {line}
      </button>
    )
  }

  const commentForm = (afterIndex: number | undefined): React.JSX.Element | null =>
    selection && onAddComment && afterIndex === selectedTo ? (
      <DiffCommentForm
        key={`${selectedFrom}-${selectedTo}`}
        selection={selection}
        onCancel={() => setRange(null)}
        onSubmit={(comment) => {
          const added = onAddComment(selection, comment.trim())
          if (added) setRange(null)
          return added
        }}
      />
    ) : null

  return (
    <div className="rich-diff-block">
      <div className="rich-diff-toolbar">
        <div className="rich-diff-view-toggle" aria-label="Diff layout">
          <button
            type="button"
            className={view === 'unified' ? 'active' : ''}
            onClick={() => setView('unified')}
          >
            Unified
          </button>
          <button
            type="button"
            className={view === 'split' ? 'active' : ''}
            onClick={() => setView('split')}
          >
            Split
          </button>
        </div>
        {onAddComment && !range && (
          <span className="rich-diff-comment-hint">
            <MessageSquarePlus size={11} aria-hidden="true" />
            Click a line number to comment
          </span>
        )}
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
          {splitRows.map((row, index) =>
            row.marker !== undefined ? (
              <div key={`${index}-${row.marker}`} className="rich-diff-split-marker">
                {row.marker}
              </div>
            ) : (
              <Fragment key={index}>
                <div className="rich-diff-split-row">
                  {[row.left, row.right].map((cell, side) => (
                    <div
                      key={side}
                      className={`rich-diff-split-cell ${cell ? `is-${cell.kind}` : 'is-empty'}${cell && onAddComment && isSelected(cell.index) ? ' is-selected' : ''}`}
                    >
                      {(cell && lineButton(cell.index, cell.line)) || (
                        <span>{cell?.line ?? ''}</span>
                      )}
                      <code>{cell?.text || ' '}</code>
                    </div>
                  ))}
                </div>
                {commentForm(
                  [row.left?.index, row.right?.index].includes(selectedTo) ? selectedTo : undefined
                )}
              </Fragment>
            )
          )}
        </div>
      ) : (
        <div className={`rich-diff-lines${onAddComment ? ' is-commentable' : ''}`}>
          {visible.map((row, index) => (
            <Fragment key={`${index}-${row.text}`}>
              <div
                className={`rich-diff-line is-${row.kind}${row.index !== undefined && onAddComment && isSelected(row.index) && isCommentableDiffRow(row) ? ' is-selected' : ''}`}
              >
                {onAddComment && (
                  <span className="rich-diff-gutter">
                    {row.index !== undefined && lineButton(row.index, row.newLine ?? row.oldLine)}
                  </span>
                )}
                {row.text || ' '}
              </div>
              {commentForm(row.index)}
            </Fragment>
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
