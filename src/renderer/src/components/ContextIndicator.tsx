import { useState, useEffect, useId } from 'react'
import { CircleHelp } from 'lucide-react'
import type { PinnedModel } from '../../../shared/models'
import { providerKindForTransport } from '../../../shared/providerRegistry'
import { calculateContextCapacity, resolveMaxOutputTokens } from '../../../shared/contextBudget'
import { resolveContextDisplay } from '../utils/contextDisplay'
import './ContextIndicator.css'

const RING_STROKE = 2.25
const RING_RADIUS = 8 - RING_STROKE / 2 - 0.25

interface ContextIndicatorProps {
  currentTokens: number
  maxTokens: number
  selectedModel: string
  model?: PinnedModel
  autoCompactEnabled?: boolean
  autoCompactThreshold?: number
  conversationCost?: number
}

function ContextIndicator({
  currentTokens,
  maxTokens,
  selectedModel,
  model,
  autoCompactEnabled = true,
  autoCompactThreshold = 0.8,
  conversationCost = 0
}: ContextIndicatorProps): React.JSX.Element {
  const contextKey = `${model?.providerInstanceId || ''}|${model?.providerModelId || selectedModel}`
  const [fetchedContext, setFetchedContext] = useState<{
    key: string
    value: number
    reliable: boolean
  } | null>(null)
  const resolvedForModel = fetchedContext?.key === contextKey ? fetchedContext : null
  const contextDisplay = resolveContextDisplay(
    selectedModel,
    model?.contextLength,
    resolvedForModel,
    maxTokens
  )
  const modelContextWindow = contextDisplay.contextWindow
  const [hovering, setHovering] = useState(false)
  const [focused, setFocused] = useState(false)
  const tooltipOpen = hovering || focused
  const tooltipId = useId()

  // Fetch model's actual context window size
  useEffect(() => {
    if (!model) return
    const fetchModelInfo = async (): Promise<void> => {
      try {
        const result = await window.api.providers.resolveContext({
          providerInstanceId: model.providerInstanceId,
          providerKind: model.providerKind ?? providerKindForTransport(model.provider),
          model: model.providerModelId || model.name,
          contextLength: model.contextLength
        })
        if (result.contextLength) {
          setFetchedContext({
            key: contextKey,
            value: result.contextLength,
            reliable: result.reliable
          })
        }
      } catch (error) {
        console.warn('Failed to fetch model context window:', error)
      }
    }

    void fetchModelInfo()
  }, [model, contextKey])

  const percentage = contextDisplay.reliable
    ? Math.min((currentTokens / modelContextWindow) * 100, 100)
    : 0
  // A 16px ring, the size of the composer's icons: radius 7.25 plus half its 1.5px stroke.
  const circumference = 2 * Math.PI * RING_RADIUS
  const strokeDashoffset = circumference - (percentage / 100) * circumference
  // Under 1% the meter is only its track: a "0" reads as a stray digit, and a sliver of arc as a
  // rendering fault. The accessible name and the tooltip still give the exact value.
  const roundedPercentage = Math.round(percentage)

  const capacity = calculateContextCapacity({
    contextLength: modelContextWindow,
    reservedOutputTokens: resolveMaxOutputTokens(
      modelContextWindow,
      model?.maxOutputTokens,
      model?.outputTokenLimit
    ),
    compactionThreshold: autoCompactThreshold
  })
  const thresholdTokens = capacity.compactionTriggerTokens
  const thresholdPosition = Math.min((thresholdTokens / modelContextWindow) * 100, 100)
  const tokensUntilCompact = Math.max(0, thresholdTokens - currentTokens)
  const contextState = !autoCompactEnabled
    ? 'Manual'
    : currentTokens >= modelContextWindow
      ? 'Over limit'
      : currentTokens >= thresholdTokens
        ? 'Ready to compact'
        : currentTokens >= thresholdTokens * 0.85
          ? 'Near limit'
          : 'Healthy'
  const contextStateTone = !autoCompactEnabled
    ? 'manual'
    : currentTokens >= thresholdTokens
      ? 'danger'
      : currentTokens >= thresholdTokens * 0.85
        ? 'warning'
        : 'healthy'

  // Match the indicator to the real compaction boundary when auto-compaction is enabled. The arc
  // and the bar carry no text, so they take the mark tokens, as the state dots do.
  const getColor = (): string => {
    if (autoCompactEnabled) {
      if (currentTokens >= thresholdTokens) return 'var(--color-error-mark)'
      if (currentTokens >= thresholdTokens * 0.85) return 'var(--color-warning-mark)'
      return 'var(--accent)'
    }
    if (percentage < 80) return 'var(--accent)'
    if (percentage < 95) return 'var(--color-warning-mark)'
    return 'var(--color-error-mark)'
  }

  // The meter has no action, but it takes focus so the keyboard can open its tooltip too. The
  // focusable mark carries the role, so the tooltip beside it is not swallowed as part of an image.
  const meterProps = {
    role: 'img',
    tabIndex: 0,
    'aria-label': contextDisplay.reliable
      ? `${currentTokens.toLocaleString()} / ${modelContextWindow.toLocaleString()} tokens (${percentage.toFixed(1)}%)`
      : `${currentTokens.toLocaleString()} tokens used · model context limit unknown`,
    'aria-describedby': tooltipOpen ? tooltipId : undefined,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Escape' && tooltipOpen) {
        event.stopPropagation()
        setFocused(false)
        setHovering(false)
      }
    }
  } as const

  return (
    <div
      className="context-indicator"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {contextDisplay.reliable ? (
        <span className="context-ring" {...meterProps}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle
              cx="8"
              cy="8"
              r={RING_RADIUS}
              fill="none"
              // With no arc the track is all there is, so it stays a step quieter; it firms up
              // once an accent arc needs something to read against.
              stroke={roundedPercentage > 0 ? 'var(--border-color)' : 'var(--border-subtle)'}
              strokeWidth={RING_STROKE}
            />
            {roundedPercentage > 0 && (
              <circle
                cx="8"
                cy="8"
                r={RING_RADIUS}
                fill="none"
                stroke={getColor()}
                strokeWidth={RING_STROKE}
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                transform="rotate(-90 8 8)"
                style={{
                  transition: 'stroke-dashoffset 0.3s ease, stroke 0.3s ease'
                }}
              />
            )}
          </svg>
        </span>
      ) : (
        <span className="context-unknown-mark" {...meterProps}>
          <CircleHelp size={16} strokeWidth={1.75} aria-hidden="true" />
        </span>
      )}

      {/* Tooltip */}
      {tooltipOpen && (
        <div
          id={tooltipId}
          role="tooltip"
          className={`context-tooltip ${contextDisplay.reliable ? '' : 'unknown'}`}
        >
          {!contextDisplay.reliable && (
            <div className="context-tooltip-unknown-copy">
              <strong>Context limit unavailable</strong>
              <p>The provider did not report a limit for this model, so a 32k window is assumed.</p>
              <small>
                Compaction will run early until you set the real value in Settings → Providers →
                Model details.
              </small>
            </div>
          )}
          {contextDisplay.reliable && (
            <>
              <div className="context-tooltip-header">
                <span className="context-tooltip-title">
                  Context
                  <small className={`context-state ${contextStateTone}`}>{contextState}</small>
                </span>
                <strong>{percentage.toFixed(1)}%</strong>
              </div>

              <div className="context-usage-summary">
                <strong>{compactTokens(currentTokens)}</strong>
                <span>of {compactTokens(modelContextWindow)} tokens</span>
              </div>

              <div className="context-capacity-visual" aria-hidden="true">
                <span
                  className="context-capacity-fill"
                  style={{ width: `${percentage}%`, background: getColor() }}
                />
                {autoCompactEnabled && (
                  <span
                    className="context-threshold-marker"
                    style={{ left: `${thresholdPosition}%` }}
                  />
                )}
              </div>

              <div className={`context-threshold-line ${contextStateTone}`}>
                {autoCompactEnabled ? (
                  <>
                    <span>
                      <i />
                      Auto-compact
                      <strong>
                        {Math.round(thresholdPosition)}% · {compactTokens(thresholdTokens)}
                      </strong>
                    </span>
                    <small>
                      {tokensUntilCompact > 0
                        ? `${compactTokens(tokensUntilCompact)} left`
                        : 'Next safe point'}
                    </small>
                  </>
                ) : (
                  <>
                    <span>
                      <i />
                      Auto-compact off
                    </span>
                    <small>Manual</small>
                  </>
                )}
              </div>

              <p className="context-reserve-note">
                {autoCompactEnabled && thresholdPosition < autoCompactThreshold * 100 - 0.5
                  ? `Compacts before your ${Math.round(autoCompactThreshold * 100)}% setting so ${compactTokens(capacity.reservedOutputTokens)} stays free for the next response.`
                  : `${compactTokens(capacity.reservedOutputTokens)} kept free for the next response; safety margin included.`}
              </p>
            </>
          )}
          {conversationCost > 0 && (
            <div className="context-cost-row">
              <span>Session cost</span>
              <strong>{formatCostDisplay(conversationCost)}</strong>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default ContextIndicator

function formatCostDisplay(cost: number): string {
  if (cost < 0.0001) return '<$0.0001'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K`
  return Math.max(0, Math.round(tokens)).toLocaleString()
}
