import { useMemo, useState } from 'react'
import { ChevronDown, ExternalLink, FileDiff, Undo2 } from 'lucide-react'
import type { ContentSegment, ToolExecution } from '../types/chat.types'
import { changedFilesFromSegments } from '../utils/turnChanges'
import { useReviewCommentSink } from '../hooks/useReviewCommentSink'
import { RichDiffBlock } from './RichDiffBlock'
import './TurnChangeReview.css'

/** A long change list shows this many files until it is expanded, so the answer stays in view. */
const COLLAPSED_FILE_COUNT = 4

/** Undoing the file changes of the response the card belongs to. */
export interface TurnChangeUndo {
  onUndo: () => void
  undone: boolean
  disabled?: boolean
}

export function TurnChangeReview({
  segments,
  workspaceRoot,
  undo
}: {
  segments: readonly ContentSegment[]
  workspaceRoot?: string | null
  undo?: TurnChangeUndo
}): React.JSX.Element | null {
  const files = useMemo(() => changedFilesFromSegments(segments), [segments])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const addReviewComment = useReviewCommentSink()
  if (!files.length) return null
  const additions = files.reduce((total, file) => total + file.additions, 0)
  const deletions = files.reduce((total, file) => total + file.deletions, 0)
  const verb = files.every((file) => file.kind === 'create') ? 'Created' : 'Edited'
  const withDiffs = files.filter((file) => file.diff)
  const allOpen = withDiffs.length > 0 && withDiffs.every((file) => expanded.has(file.path))
  const visible = showAll ? files : files.slice(0, COLLAPSED_FILE_COUNT)
  const hidden = files.length - visible.length

  const toggle = (path: string): void =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <section className="turn-change-review" aria-label="Files changed in this response">
      <div className="turn-change-review-header">
        <span className="turn-change-review-icon" aria-hidden="true">
          <FileDiff size={16} />
        </span>
        <span className="turn-change-review-title">
          <strong>
            {verb} {files.length} {files.length === 1 ? 'file' : 'files'}
          </strong>
          <span className="turn-change-review-stats">
            <span className="is-add">+{additions}</span>
            <span className="is-delete">−{deletions}</span>
          </span>
        </span>
        <span className="turn-change-review-actions">
          {undo && (
            <button
              type="button"
              className="turn-change-review-undo"
              onClick={undo.onUndo}
              disabled={undo.disabled || undo.undone}
              title={
                undo.undone ? 'These changes are undone' : 'Undo the file changes of this response'
              }
            >
              {undo.undone ? 'Undone' : 'Undo'}
              <Undo2 size={14} aria-hidden="true" />
            </button>
          )}
          {withDiffs.length > 0 && (
            <button
              type="button"
              className="turn-change-review-view"
              aria-expanded={allOpen}
              onClick={() => {
                if (allOpen) {
                  setExpanded(new Set())
                  return
                }
                setShowAll(true)
                setExpanded(new Set(withDiffs.map((file) => file.path)))
              }}
            >
              {allOpen ? 'Hide changes' : 'View changes'}
            </button>
          )}
        </span>
      </div>
      <div className="turn-change-review-files">
        {visible.map((file) => {
          const open = expanded.has(file.path)
          const slash = file.path.lastIndexOf('/')
          const syntheticTool: ToolExecution = {
            id: `review:${file.path}`,
            title: file.path,
            command: '',
            status: 'success',
            data: { diff: file.diff },
            changes: [{ path: file.path, kind: file.kind, previousPath: file.previousPath }]
          }
          return (
            <div className="turn-change-file" key={file.path} data-open={open || undefined}>
              <div
                className="turn-change-file-row"
                onContextMenu={(event) => {
                  event.preventDefault()
                  if (workspaceRoot)
                    void window.api.workspace.showPathMenu(file.path, workspaceRoot)
                }}
              >
                <button
                  type="button"
                  className="turn-change-file-toggle"
                  onClick={() => file.diff && toggle(file.path)}
                  aria-expanded={file.diff ? open : undefined}
                  title={file.path}
                >
                  <span className="turn-change-file-path">
                    {slash >= 0 && (
                      <span className="turn-change-file-dir">{file.path.slice(0, slash + 1)}</span>
                    )}
                    <span className="turn-change-file-name">{file.path.slice(slash + 1)}</span>
                  </span>
                  {file.kind !== 'update' && (
                    <span className={`turn-change-kind is-${file.kind}`}>
                      {file.kind === 'create' ? 'new' : file.kind}
                    </span>
                  )}
                </button>
                {workspaceRoot && (
                  <button
                    type="button"
                    className="turn-change-open"
                    onClick={() => void window.api.workspace.openFile(file.path, workspaceRoot)}
                    aria-label={`Open ${file.path}`}
                    title="Open file"
                  >
                    <ExternalLink size={12} />
                  </button>
                )}
                <span className="turn-change-file-stats">
                  <span className="is-add">+{file.additions}</span>
                  <span className="is-delete">−{file.deletions}</span>
                </span>
              </div>
              {open && file.diff && (
                <RichDiffBlock
                  tool={syntheticTool}
                  onAddComment={
                    addReviewComment
                      ? (selection, comment) =>
                          addReviewComment({ path: file.path, ...selection, comment })
                      : undefined
                  }
                />
              )}
            </div>
          )
        })}
      </div>
      {files.length > COLLAPSED_FILE_COUNT && (
        <button
          type="button"
          className="turn-change-review-more"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? 'Show fewer files' : `Show ${hidden} more ${hidden === 1 ? 'file' : 'files'}`}
          <ChevronDown size={14} aria-hidden="true" className={showAll ? 'is-open' : ''} />
        </button>
      )}
    </section>
  )
}
