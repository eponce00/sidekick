import { AlertCircle, Check, Loader2, Pause, Pencil, Play, Target, X } from 'lucide-react'
import type { ConversationGoal } from '../../../shared/conversationGoals'

interface ConversationGoalBarProps {
  goal: ConversationGoal
  isRunning: boolean
  onEdit: () => void
  onPause: () => void
  onResume: () => void
  onClear: () => void
}

export function ConversationGoalBar({
  goal,
  isRunning,
  onEdit,
  onPause,
  onResume,
  onClear
}: ConversationGoalBarProps): React.JSX.Element {
  const completed = goal.plan.filter((item) => item.status === 'completed').length
  const status =
    goal.status === 'completed'
      ? 'Complete'
      : goal.status === 'blocked'
        ? 'Blocked'
        : goal.status === 'paused'
          ? 'Paused'
          : isRunning
            ? 'Working'
            : 'Ready to continue'
  const StatusIcon =
    goal.status === 'completed'
      ? Check
      : goal.status === 'blocked'
        ? AlertCircle
        : isRunning
          ? Loader2
          : Target

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
      <span className="goal-mode-progress">
        {goal.plan.length ? `${completed}/${goal.plan.length}` : `${goal.continuationCount} turns`}
      </span>
      <span className="goal-mode-actions">
        {goal.status === 'active' ? (
          <button type="button" onClick={onPause} title="Pause goal" aria-label="Pause goal">
            <Pause size={13} />
          </button>
        ) : goal.status === 'paused' || goal.status === 'blocked' ? (
          <button type="button" onClick={onResume} title="Resume goal" aria-label="Resume goal">
            <Play size={13} />
          </button>
        ) : null}
        {goal.status !== 'completed' && (
          <button type="button" onClick={onEdit} title="Edit goal" aria-label="Edit goal">
            <Pencil size={13} />
          </button>
        )}
        <button type="button" onClick={onClear} title="Clear goal" aria-label="Clear goal">
          <X size={13} />
        </button>
      </span>
    </div>
  )
}
