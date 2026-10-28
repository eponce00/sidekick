import { useEffect, useId, useRef, useState } from 'react'
import {
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  RefreshCw,
  TriangleAlert,
  X
} from 'lucide-react'
import {
  pullRequestMergeStatus,
  summarizePullRequestChecks,
  type PullRequestCheck,
  type PullRequestChecksSummary,
  type PullRequestSummary
} from '../../../shared/pullRequests'
import { usePullRequestStatus } from '../hooks/usePullRequestStatus'
import { DiffCounts } from './DiffCounts'
import './PullRequestBar.css'

const CHECK_LABELS: Record<PullRequestChecksSummary, string> = {
  none: 'No checks',
  pending: 'Checks running',
  success: 'Checks passed',
  failure: 'Checks failed',
  skipped: 'Checks skipped'
}

const CHECK_STATE_LABELS: Record<PullRequestCheck['state'], string> = {
  pending: 'Running',
  success: 'Passed',
  failure: 'Failed',
  skipped: 'Skipped'
}

const CHECK_ICONS = {
  pending: CircleDashed,
  success: CircleCheck,
  failure: CircleX,
  skipped: CircleSlash
}

/**
 * The branch's GitHub pull request under the composer: state, merge status, changed lines,
 * and CI. It only reads; "Create PR" opens GitHub's compare form for the user to submit.
 */
export function PullRequestBar({
  workspaceRoot
}: {
  workspaceRoot: string | null
}): React.JSX.Element | null {
  if (!workspaceRoot) return null
  // Remount per folder so another repository's pull request never flashes.
  return <WorkspacePullRequestBar key={workspaceRoot} workspaceRoot={workspaceRoot} />
}

function WorkspacePullRequestBar({
  workspaceRoot
}: {
  workspaceRoot: string
}): React.JSX.Element | null {
  const { status, error, loading, refresh, dismissError } = usePullRequestStatus(workspaceRoot)
  if (!status) return null
  const pr = status.pullRequest
  if (!pr && !status.createUrl) return null
  const merge = pr ? pullRequestMergeStatus(pr) : null

  return (
    <section className="pull-request-bar" aria-label="Pull request status">
      {/* Four groups, 12px apart: the pull request and its state, its lines, its checks, and the
          branch, which alone gives way when the row is short. */}
      <div className="pull-request-bar-row">
        {pr ? (
          <>
            <span className="pull-request-bar-group">
              <PullRequestIcon pr={pr} className="pull-request-bar-icon" />
              <a
                className="pull-request-bar-number"
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                title={pr.title}
                aria-label={`Open pull request #${pr.number} on GitHub: ${pr.title}`}
              >
                #{pr.number}
              </a>
              {/* A status chip's anatomy: the dot carries the colour, the word stays grey. */}
              <span className={`pull-request-bar-merge is-${merge?.tone}`}>
                <span className="pull-request-bar-merge-dot" aria-hidden="true" />
                {merge?.label}
              </span>
            </span>
            <span
              className="pull-request-bar-lines"
              title={`${pr.additions.toLocaleString()} lines added, ${pr.deletions.toLocaleString()} removed`}
            >
              <DiffCounts additions={pr.additions} deletions={pr.deletions} />
            </span>
            <PullRequestChecks pr={pr} />
          </>
        ) : (
          status.createUrl && (
            <span className="pull-request-bar-group">
              <PullRequestIcon pr={pr} className="pull-request-bar-icon" />
              <a
                className="pull-request-bar-create"
                href={status.createUrl}
                target="_blank"
                rel="noreferrer"
                title="Open GitHub’s compare form for this branch. Push your commits before you submit it."
              >
                Create PR
                <ExternalLink size={11} aria-hidden="true" />
              </a>
            </span>
          )
        )}
        <span className="pull-request-bar-branch" title={`${status.repository} · ${status.branch}`}>
          <GitBranch size={12} aria-hidden="true" />
          <span className="pull-request-bar-branch-name">{status.branch}</span>
        </span>
        <button
          type="button"
          className="pull-request-bar-refresh"
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh pull request status"
          title="Refresh pull request status"
        >
          <RefreshCw size={12} className={loading ? 'icon-spin' : undefined} aria-hidden="true" />
        </button>
      </div>
      {error && (
        <div className="pull-request-bar-error" role="status">
          <TriangleAlert size={12} aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={dismissError} aria-label="Dismiss pull request error">
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  )
}

function PullRequestIcon({
  pr,
  className
}: {
  pr: PullRequestSummary | null
  className: string
}): React.JSX.Element {
  const props = { size: 14, className, 'aria-hidden': true }
  if (pr?.state === 'merged' || pr?.state === 'queued') return <GitMerge {...props} />
  if (pr?.state === 'closed') return <GitPullRequestClosed {...props} />
  if (pr?.state === 'draft') return <GitPullRequestDraft {...props} />
  return <GitPullRequest {...props} />
}

function PullRequestChecks({ pr }: { pr: PullRequestSummary }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const summary = summarizePullRequestChecks(pr.checks)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const counts = pr.checks.reduce<Record<PullRequestCheck['state'], number>>(
    (total, check) => ({ ...total, [check.state]: total[check.state] + 1 }),
    { failure: 0, pending: 0, success: 0, skipped: 0 }
  )
  const countText = (['failure', 'pending', 'success', 'skipped'] as const)
    .filter((state) => counts[state])
    .map((state) => `${counts[state]} ${CHECK_STATE_LABELS[state].toLowerCase()}`)
    .join(' · ')

  return (
    <div className="pull-request-checks" ref={rootRef}>
      <button
        type="button"
        className={`pull-request-checks-trigger is-${summary}`}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="pull-request-checks-dot" aria-hidden="true" />
        {CHECK_LABELS[summary]}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="pull-request-checks-card" id={listId} role="dialog" aria-label="CI checks">
          <div className="pull-request-checks-heading">
            <span>Checks for #{pr.number}</span>
            {countText && <span className="pull-request-checks-counts">{countText}</span>}
          </div>
          {pr.checks.length ? (
            <ul className="pull-request-checks-list">
              {pr.checks.map((check, index) => {
                const CheckIcon = CHECK_ICONS[check.state]
                return (
                  <li key={`${check.name}:${index}`} className={`is-${check.state}`}>
                    <CheckIcon size={13} aria-hidden="true" />
                    {check.url ? (
                      <a
                        href={check.url}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open the log for ${check.name}`}
                      >
                        <span>{check.name}</span>
                        <ExternalLink size={10} aria-hidden="true" />
                      </a>
                    ) : (
                      <span className="pull-request-checks-name">{check.name}</span>
                    )}
                    <span className="pull-request-checks-state">
                      {CHECK_STATE_LABELS[check.state]}
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="pull-request-checks-empty">No checks reported for this pull request.</p>
          )}
        </div>
      )}
    </div>
  )
}
