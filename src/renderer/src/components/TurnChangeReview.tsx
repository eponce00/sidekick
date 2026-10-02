import { useMemo, useState } from 'react'
import { ChevronRight, ExternalLink, Files } from 'lucide-react'
import type { ContentSegment, ToolExecution } from '../types/chat.types'
import { changedFilesFromSegments } from '../utils/turnChanges'
import { useReviewCommentSink } from '../hooks/useReviewCommentSink'
import { RichDiffBlock } from './RichDiffBlock'
import './TurnChangeReview.css'

/** A long change list shows this many files until it is expanded, so the answer stays in view. */
const COLLAPSED_FILE_COUNT = 4

export function TurnChangeReview({
  segments,
  workspaceRoot
}: {
  segments: readonly ContentSegment[]
  workspaceRoot?: string | null
}): React.JSX.Element | null {
  const files = useMemo(() => changedFilesFromSegments(segments), [segments])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const addReviewComment = useReviewCommentSink()
  if (!files.length) return null
  const additions = files.reduce((total, file) => total + file.additions, 0)
  const deletions = files.reduce((total, file) => total + file.deletions, 0)

  const openPath = (path: string): void => {
    if (!workspaceRoot) return
    void window.api.workspace.openFile(path, workspaceRoot)
  }

  return (
    <section className="turn-change-review" aria-label="Files changed in this response">
      <div className="turn-change-review-header">
        <span>
          <Files size={14} /> {files.length} {files.length === 1 ? 'file' : 'files'} changed
        </span>
        <span className="turn-change-review-stats">
          <strong>+{additions}</strong>
          <em>−{deletions}</em>
        </span>
      </div>
      <div className="turn-change-review-files">
        {(showAll ? files : files.slice(0, COLLAPSED_FILE_COUNT)).map((file) => {
          const open = expanded.has(file.path)
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
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current)
                      if (next.has(file.path)) next.delete(file.path)
                      else next.add(file.path)
                      return next
                    })
                  }
                  aria-expanded={open}
                >
                  <ChevronRight size={13} className={open ? 'expanded' : ''} />
                  <span className="turn-change-file-path" title={file.path}>
                    {file.path.includes('/') && (
                      <span className="turn-change-file-dir">
                        {file.path.slice(0, file.path.lastIndexOf('/') + 1)}
                      </span>
                    )}
                    {file.path.slice(file.path.lastIndexOf('/') + 1)}
                  </span>
                  <span className={`turn-change-kind is-${file.kind}`}>{file.kind}</span>
                </button>
                <span className="turn-change-file-stats">
                  {file.additions > 0 && <strong>+{file.additions}</strong>}
                  {file.deletions > 0 && <em>−{file.deletions}</em>}
                </span>
                {workspaceRoot && (
                  <button
                    type="button"
                    className="turn-change-open"
                    onClick={() => openPath(file.path)}
                    aria-label={`Open ${file.path}`}
                  >
                    <ExternalLink size={12} />
                  </button>
                )}
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
          {showAll
            ? 'Show fewer files'
            : `Show ${files.length - COLLAPSED_FILE_COUNT} more ${
                files.length - COLLAPSED_FILE_COUNT === 1 ? 'file' : 'files'
              }`}
        </button>
      )}
    </section>
  )
}
