import { AlertCircle, Loader2, Pause, Play, Target, X } from 'lucide-react'
import type { ConversationGoal } from '../../../shared/conversationGoals'

interface ConversationGoalBarProps {
  goal: ConversationGoal
  isRunning: boolean
  onPause: () => void
  onResume: () => void
  onClear: () => void
}

/**
 * The bar states what the goal is and what is happening to it. It never
 * reports completion: a finished goal is reported in the conversation, where
 * the rest of the outcome is, and stops occupying the composer because the
 * next message is not part of it.
 */
export function ConversationGoalBar({
  goal,
  isRunning,
  onPause,
  onResume,
  onClear
}: ConversationGoalBarProps): React.JSX.Element {
  const status =
    goal.status === 'blocked'
      ? 'Blocked'
      : goal.status === 'paused'
        ? 'Paused'
        : isRunning
          ? 'Working'
          : 'Ready to continue'
  const StatusIcon = goal.status === 'blocked' ? AlertCircle : isRunning ? Loader2 : Target

  return (
    <div className={`goal-mode-bar is-${goal.status}`} role="status" aria-live="polite">
      <span className="goal-mode-icon" aria-hidden="true">
        <StatusIcon
          size={14}
          className={isRunning && goal.status === 'active' ? 'icon-spin' : ''}
        />
      </span>
      <span className="goal-mode-copy">
        <strong>{status}</strong>
        <span title={goal.objective}>{goal.objective}</span>
      </span>
      <span className="goal-mode-actions">
        {goal.status === 'active' ? (
          <button type="button" onClick={onPause} title="Pause goal" aria-label="Pause goal">
            <Pause size={13} />
          </button>
        ) : (
          <button type="button" onClick={onResume} title="Resume goal" aria-label="Resume goal">
            <Play size={13} />
          </button>
        )}
        <button type="button" onClick={onClear} title="Drop goal" aria-label="Drop goal">
          <X size={13} />
        </button>
      </span>
    </div>
  )
}

/**
 * Shown between choosing to set a goal and writing it. The objective is typed
 * into the composer like any other message, so this says what the next message
 * will become and offers the way out of that.
 */
export function GoalArmedBar({ onCancel }: { onCancel: () => void }): React.JSX.Element {
  return (
    <div className="goal-mode-bar is-armed">
      <span className="goal-mode-icon" aria-hidden="true">
        <Target size={14} />
      </span>
      <span className="goal-mode-copy">
        <strong>Goal</strong>
        <span>Your next message becomes the objective SideKick works toward</span>
      </span>
      <span className="goal-mode-actions">
        <button type="button" onClick={onCancel} title="Cancel goal" aria-label="Cancel goal">
          <X size={13} />
        </button>
      </span>
    </div>
  )
}
