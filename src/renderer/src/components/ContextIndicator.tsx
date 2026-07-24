import { useState, useEffect } from 'react'
import { CircleHelp } from 'lucide-react'
import type { PinnedModel } from '../../../shared/models'
import { providerKindForTransport } from '../../../shared/providerRegistry'
import { calculateContextCapacity, resolveMaxOutputTokens } from '../../../shared/contextBudget'
import { resolveContextDisplay } from '../utils/contextDisplay'
import './ContextIndicator.css'

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
  const [isHovering, setIsHovering] = useState(false)

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
  const circumference = 2 * Math.PI * 16 // radius = 16
  const strokeDashoffset = circumference - (percentage / 100) * circumference

  const capacity = calculateContextCapacity({
    contextLength: modelContextWindow,
    reservedOutputTokens: resolveMaxOutputTokens(modelContextWindow, model?.maxOutputTokens),
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

  // Match the indicator to the real compaction boundary when auto-compaction is enabled.
  const getColor = (): string => {
    if (autoCompactEnabled) {
      if (currentTokens >= thresholdTokens) return 'var(--color-error)'
      if (currentTokens >= thresholdTokens * 0.85) return 'var(--color-warning, #f5a524)'
      return 'var(--accent)'
    }
    if (percentage < 80) return 'var(--accent)'
    if (percentage < 95) return 'var(--color-warning, #f5a524)'
    return 'var(--color-error)'
  }

  return (
    <div
      className="context-indicator"
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      aria-label={
        contextDisplay.reliable
          ? `${currentTokens.toLocaleString()} / ${modelContextWindow.toLocaleString()} tokens (${percentage.toFixed(1)}%)`
          : `${currentTokens.toLocaleString()} tokens used · model context limit unknown`
      }
    >
      {contextDisplay.reliable ? (
        <svg width="28" height="28" viewBox="0 0 36 36">
          <circle cx="18" cy="18" r="16" fill="none" stroke="var(--panel-border)" strokeWidth="3" />
          <circle
            cx="18"
            cy="18"
            r="16"
            fill="none"
            stroke={getColor()}
            strokeWidth="3"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            transform="rotate(-90 18 18)"
            style={{
              transition: 'stroke-dashoffset 0.3s ease, stroke 0.3s ease'
            }}
          />
          <text
            x="18"
            y="18"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="10"
            fontWeight="600"
            fill="var(--text-secondary)"
          >
            {percentage >= 100 ? '99+' : Math.round(percentage)}
          </text>
        </svg>
      ) : (
        <span className="context-unknown-mark" aria-label="Context limit unknown">
          <CircleHelp size={16} strokeWidth={1.8} />
        </span>
      )}

      {/* Tooltip */}
      {isHovering && (
        <div className={`context-tooltip ${contextDisplay.reliable ? '' : 'unknown'}`}>
          {!contextDisplay.reliable && (
            <div className="context-tooltip-unknown-copy">
              <strong>Context limit unavailable</strong>
              <p>LiteLLM did not report a limit for this model.</p>
              <small>Set it in Settings → Providers → Model details.</small>
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
                        {Math.round(autoCompactThreshold * 100)}% · {compactTokens(thresholdTokens)}
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
                {compactTokens(capacity.reservedOutputTokens)} reserved for the next response;
                safety margin included.
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
