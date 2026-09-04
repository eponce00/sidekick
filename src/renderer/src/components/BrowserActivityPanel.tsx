import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  ExternalLink,
  LoaderCircle,
  Maximize2,
  Minimize2,
  MonitorUp,
  MousePointer2,
  ShieldAlert
} from 'lucide-react'
import type { AgentRunEvent } from '../../../shared/agentRuntime'
import {
  applyBrowserActivityEvent,
  EMPTY_BROWSER_ACTIVITY,
  type BrowserActivityState
} from '../utils/browserActivity'
import './BrowserActivityPanel.css'

export interface BrowserActivityPanelProps {
  conversationId: string | null
  onActivityChange?: (state: BrowserActivityState) => void
  isWide?: boolean
  onToggleWidth?: () => void
}

function activityStatus(
  state: BrowserActivityState
): 'live' | 'blocked' | 'error' | 'verified' | 'idle' {
  const latest = state.timeline[state.timeline.length - 1]
  if (state.humanVerification) return 'blocked'
  if (latest?.status === 'running' || latest?.status === 'pending') return 'live'
  if (latest?.status === 'partial' || latest?.status === 'error' || latest?.status === 'denied')
    return 'error'
  if (state.verification?.status === 'passed') return 'verified'
  return 'idle'
}

function statusLabel(state: BrowserActivityState): string {
  const status = activityStatus(state)
  if (status === 'live') return 'Live'
  if (status === 'blocked') return 'Human action required'
  if (status === 'error') return 'Needs attention'
  if (status === 'verified') return 'Verified'
  return state.sessionState || 'Ready'
}

export function BrowserActivityPanel({
  conversationId,
  onActivityChange,
  isWide,
  onToggleWidth
}: BrowserActivityPanelProps): React.JSX.Element {
  return (
    <BrowserActivityPanelSession
      key={conversationId ?? 'no-conversation'}
      conversationId={conversationId}
      onActivityChange={onActivityChange}
      isWide={isWide}
      onToggleWidth={onToggleWidth}
    />
  )
}

function BrowserActivityPanelSession({
  conversationId,
  onActivityChange,
  isWide = false,
  onToggleWidth
}: BrowserActivityPanelProps): React.JSX.Element {
  const [activity, setActivity] = useState<BrowserActivityState>(EMPTY_BROWSER_ACTIVITY)
  const [failedScreenshot, setFailedScreenshot] = useState<string | null>(null)
  const activeRunIds = useRef(new Set<string>())
  const activityRef = useRef<BrowserActivityState>(EMPTY_BROWSER_ACTIVITY)

  const ingest = useCallback(
    (event: AgentRunEvent): void => {
      if (event.type === 'run.started') {
        if (String(event.payload.threadId || '') === conversationId) {
          activeRunIds.current.add(event.runId)
        }
        return
      }
      if (!activeRunIds.current.has(event.runId)) return
      const next = applyBrowserActivityEvent(activityRef.current, event)
      if (next === activityRef.current) return
      activityRef.current = next
      setActivity(next)
    },
    [conversationId]
  )

  useEffect(() => {
    if (!conversationId) return

    let cancelled = false
    void window.api.agentRuns
      .latest(conversationId)
      .then((result) => {
        if (cancelled || !result.run) return
        activeRunIds.current.add(result.run.id)
        const reconstructed = result.events.reduce(
          (current, event) => applyBrowserActivityEvent(current, event),
          EMPTY_BROWSER_ACTIVITY
        )
        if (activityRef.current.lastSequence > reconstructed.lastSequence) return
        activityRef.current = reconstructed
        setActivity(reconstructed)
      })
      .catch((error) => console.warn('[BrowserActivity] Could not restore latest run', error))

    return () => {
      cancelled = true
    }
  }, [conversationId])

  useEffect(() => window.api.agentRuns.onEvent(({ event }) => ingest(event)), [ingest])

  useEffect(() => {
    onActivityChange?.(activity)
  }, [activity, onActivityChange])

  const stateStatus = activityStatus(activity)
  const latest = activity.timeline[activity.timeline.length - 1]
  const pageLabel = activity.pageTitle || activity.url || 'Browser session'
  const previewSize = activity.screenshotSize || activity.viewport
  const previewIsPortrait = Boolean(previewSize && previewSize.height > previewSize.width * 1.15)
  const emptyPreviewLabel =
    stateStatus === 'live' && latest?.name === 'browser_open'
      ? 'Opening page…'
      : stateStatus === 'live' && latest?.name === 'browser_screenshot'
        ? 'Capturing screenshot…'
        : 'Waiting for screenshot'

  return (
    <aside
      className="browser-activity-panel"
      aria-label="Browser activity"
      data-status={stateStatus}
    >
      <header className="browser-activity-header">
        <div className="browser-activity-heading-icon" aria-hidden="true">
          <MonitorUp size={16} />
        </div>
        <div className="browser-activity-heading">
          <strong>Browser activity</strong>
          <span className="browser-activity-status">
            <Circle size={7} fill="currentColor" />
            {statusLabel(activity)}
          </span>
        </div>
        {onToggleWidth && (
          <button
            className="browser-activity-icon-button"
            type="button"
            onClick={onToggleWidth}
            title={isWide ? 'Restore browser panel width' : 'Widen browser panel'}
            aria-label={isWide ? 'Restore browser panel width' : 'Widen browser panel'}
          >
            {isWide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        )}
      </header>

      {!activity.hasActivity ? (
        <div className="browser-activity-empty">
          <MonitorUp size={24} />
          <strong>No browser activity yet</strong>
          <span>
            When the model opens or interacts with a page, its live view will appear here.
          </span>
        </div>
      ) : (
        <div className="browser-activity-body">
          <div className="browser-preview-stage">
            <div
              className={`browser-preview${previewIsPortrait ? ' is-portrait' : ' is-landscape'}`}
              style={
                previewSize
                  ? { aspectRatio: `${previewSize.width} / ${previewSize.height}` }
                  : undefined
              }
            >
              {activity.screenshot && activity.screenshot !== failedScreenshot ? (
                <img
                  src={activity.screenshot}
                  alt={`Current browser view${activity.pageTitle ? `: ${activity.pageTitle}` : ''}`}
                  onError={() => setFailedScreenshot(activity.screenshot ?? null)}
                />
              ) : (
                <div className="browser-preview-empty">
                  <MonitorUp size={22} />
                  <span>
                    {activity.screenshot === failedScreenshot
                      ? 'Screenshot could not be displayed'
                      : emptyPreviewLabel}
                  </span>
                </div>
              )}
              {activity.pointer &&
                activity.viewport &&
                activity.screenshotKind === 'viewport' &&
                activity.pointer.x <= activity.viewport.width &&
                activity.pointer.y <= activity.viewport.height && (
                  <span
                    key={activity.pointer.updatedAt}
                    className={`browser-pointer is-${activity.pointer.action}`}
                    style={{
                      left: `${(activity.pointer.x / activity.viewport.width) * 100}%`,
                      top: `${(activity.pointer.y / activity.viewport.height) * 100}%`
                    }}
                    title={`Last ${activity.pointer.action} at ${Math.round(activity.pointer.x)}, ${Math.round(activity.pointer.y)}`}
                    aria-label={`Last browser interaction: ${activity.pointer.action}`}
                  >
                    <MousePointer2 size={27} strokeWidth={2.35} fill="currentColor" />
                  </span>
                )}
              {activity.progress && (
                <span className="browser-preview-progress">{activity.progress}</span>
              )}
            </div>
          </div>

          <div className="browser-activity-details">
            <div className="browser-page-row">
              <div className="browser-page-copy">
                <strong title={pageLabel}>{pageLabel}</strong>
                {activity.url && activity.pageTitle && (
                  <span title={activity.url}>{activity.url}</span>
                )}
              </div>
              {activity.url && /^https?:\/\//i.test(activity.url) && (
                <a
                  className="browser-activity-icon-button"
                  href={activity.url}
                  target="_blank"
                  rel="noreferrer"
                  title="Open page in default browser"
                  aria-label="Open page in default browser"
                >
                  <ExternalLink size={14} />
                </a>
              )}
            </div>

            {latest && (
              <section className="browser-latest-action" aria-label="Latest browser action">
                <MousePointer2 size={14} />
                <div>
                  <span>Just now</span>
                  <strong>{activity.latestAction || latest.title}</strong>
                </div>
              </section>
            )}

            {activity.humanVerification && (
              <section
                className="browser-human-verification"
                aria-label="Human verification required"
              >
                <ShieldAlert size={14} />
                <span>{activity.humanVerification.message}</span>
              </section>
            )}

            {activity.verification && !activity.humanVerification && (
              <section
                className={`browser-verification is-${activity.verification.status}`}
                aria-label="Visual verification status"
              >
                {activity.verification.status === 'running' ? (
                  <LoaderCircle size={14} className="browser-activity-spin" />
                ) : activity.verification.status === 'passed' ? (
                  <CheckCircle2 size={14} />
                ) : activity.verification.status === 'review' ? (
                  <MonitorUp size={14} />
                ) : (
                  <AlertCircle size={14} />
                )}
                <span>{activity.verification.label}</span>
              </section>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}

export default BrowserActivityPanel
