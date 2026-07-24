import { useMemo, useState } from 'react'
import { Check, ListChecks, ShieldAlert, X } from 'lucide-react'
import type { ContentSegment } from '../types/chat.types'

type Interaction = NonNullable<ContentSegment['interaction']>

interface AgentInteractionCardProps {
  interaction: Interaction
  onResolve: (id: string, response: Record<string, unknown>, cancelled?: boolean) => void
}

interface QuestionOption {
  label: string
  description?: string
}

interface Question {
  id: string
  header?: string
  question: string
  options?: QuestionOption[]
}

function questionsFrom(interaction: Interaction): Question[] {
  if (!Array.isArray(interaction.request.questions)) return []
  return interaction.request.questions.filter((question): question is Question =>
    Boolean(
      question &&
      typeof question === 'object' &&
      typeof (question as Question).id === 'string' &&
      typeof (question as Question).question === 'string'
    )
  )
}

export default function AgentInteractionCard({
  interaction,
  onResolve
}: AgentInteractionCardProps): React.JSX.Element {
  const questions = useMemo(() => questionsFrom(interaction), [interaction])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [planFeedback, setPlanFeedback] = useState('')
  const [showPlanFeedback, setShowPlanFeedback] = useState(false)
  const pending = interaction.status === 'pending'

  if (interaction.kind === 'permission') {
    const title = String(interaction.request.title || 'Approve this action?')
    const detail = interaction.request.arguments
      ? JSON.stringify(interaction.request.arguments, null, 2).slice(0, 3_000)
      : ''
    return (
      <div className={`agent-interaction agent-interaction-${interaction.status}`}>
        <div className="agent-interaction-heading">
          <ShieldAlert size={14} aria-hidden="true" />
          <span>{title}</span>
        </div>
        {detail && <pre className="agent-interaction-detail">{detail}</pre>}
        {pending ? (
          <div className="agent-interaction-actions">
            <button
              type="button"
              className="agent-interaction-primary"
              onClick={() => onResolve(interaction.id, { approved: true })}
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => onResolve(interaction.id, { approved: false }, true)}
            >
              Deny
            </button>
          </div>
        ) : (
          <div className="agent-interaction-status">
            {interaction.response?.approved === true ? <Check size={12} /> : <X size={12} />}
            {interaction.response?.approved === true ? 'Approved' : 'Denied'}
          </div>
        )}
      </div>
    )
  }

  if (interaction.kind === 'plan_approval') {
    const stage = interaction.request.stage === 'entry' ? 'entry' : 'review'
    const revision = String(interaction.request.revision || '')
    const contract =
      interaction.request.contract && typeof interaction.request.contract === 'object'
        ? (interaction.request.contract as Record<string, unknown>)
        : null
    const requirements = Array.isArray(contract?.requirements)
      ? (contract.requirements as Array<Record<string, unknown>>)
      : []
    const steps = Array.isArray(contract?.steps)
      ? (contract.steps as Array<Record<string, unknown>>)
      : []
    const verification = Array.isArray(contract?.verification)
      ? (contract.verification as Array<Record<string, unknown>>)
      : []
    const resolvedAction = String(interaction.response?.action || '')
    return (
      <div
        className={`agent-interaction agent-interaction-plan agent-interaction-${interaction.status}`}
      >
        <div className="agent-interaction-heading">
          <ListChecks size={14} aria-hidden="true" />
          {stage === 'entry' ? 'Switch to Plan mode?' : String(contract?.title || 'Review plan')}
        </div>
        {stage === 'entry' ? (
          <>
            <div className="agent-interaction-copy">
              {String(
                interaction.request.reason || 'This request would benefit from planning first.'
              )}
            </div>
            <div className="agent-plan-models">
              Plan with {String(interaction.request.plannerModel || 'current model')}
              <span aria-hidden="true">→</span>
              Execute with {String(interaction.request.executorModel || 'current model')}
            </div>
          </>
        ) : contract ? (
          <div className="agent-plan-contract">
            <p>{String(contract.summary || contract.objective || '')}</p>
            <div className="agent-plan-section">
              <strong>Requirements</strong>
              {requirements.map((item, index) => (
                <div key={String(item.id || index)}>
                  <span>{String(item.outcome || item.id || '')}</span>
                  <small>{String(item.acceptance || '')}</small>
                </div>
              ))}
            </div>
            <div className="agent-plan-section">
              <strong>Approach</strong>
              {steps.map((item, index) => (
                <div key={String(item.id || index)}>
                  <span>
                    {index + 1}. {String(item.title || '')}
                  </span>
                  <small>{String(item.description || '')}</small>
                </div>
              ))}
            </div>
            <div className="agent-plan-section">
              <strong>Verification</strong>
              {verification.map((item, index) => (
                <div key={String(item.id || index)}>
                  <span>{String(item.description || '')}</span>
                  <small>{String(item.expected || '')}</small>
                </div>
              ))}
            </div>
            <div className="agent-plan-models">
              Planned by {String(interaction.request.plannerModel || 'current model')}
              <span aria-hidden="true">→</span>
              Execute with {String(interaction.request.executorModel || 'current model')}
            </div>
          </div>
        ) : null}
        {pending && showPlanFeedback && stage === 'review' && (
          <textarea
            className="agent-plan-feedback"
            value={planFeedback}
            autoFocus
            placeholder="What should change in the plan?"
            onChange={(event) => setPlanFeedback(event.target.value)}
          />
        )}
        {pending ? (
          <div className="agent-interaction-actions">
            <button
              type="button"
              className="agent-interaction-primary"
              onClick={() =>
                onResolve(interaction.id, {
                  action: 'approve',
                  approved: true,
                  ...(revision ? { revision } : {})
                })
              }
            >
              {stage === 'entry' ? 'Plan first' : 'Implement plan'}
            </button>
            {stage === 'review' && (
              <button
                type="button"
                disabled={showPlanFeedback && !planFeedback.trim()}
                onClick={() => {
                  if (!showPlanFeedback) setShowPlanFeedback(true)
                  else
                    onResolve(interaction.id, {
                      action: 'revise',
                      revision,
                      feedback: planFeedback.trim()
                    })
                }}
              >
                {showPlanFeedback ? 'Send revision notes' : 'Request changes'}
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                onResolve(interaction.id, {
                  action: 'keep',
                  ...(revision ? { revision } : {})
                })
              }
            >
              {stage === 'entry' ? 'Keep working' : 'Keep plan only'}
            </button>
          </div>
        ) : (
          <div className="agent-interaction-status">
            {resolvedAction === 'approve' ? <Check size={12} /> : <X size={12} />}
            {resolvedAction === 'approve'
              ? stage === 'entry'
                ? 'Plan mode approved'
                : 'Plan approved for implementation'
              : resolvedAction === 'revise'
                ? 'Plan revision requested'
                : stage === 'entry'
                  ? 'Stayed in Act mode'
                  : 'Plan kept without implementation'}
          </div>
        )}
      </div>
    )
  }

  const complete =
    questions.length > 0 && questions.every((question) => answers[question.id]?.trim())
  return (
    <div className={`agent-interaction agent-interaction-${interaction.status}`}>
      {questions.map((question) => (
        <div className="agent-question" key={question.id}>
          {question.header && <div className="agent-question-header">{question.header}</div>}
          <div className="agent-question-copy">{question.question}</div>
          {question.options?.length ? (
            <div className="agent-question-options">
              {question.options.map((option) => (
                <button
                  type="button"
                  key={option.label}
                  className={answers[question.id] === option.label ? 'selected' : ''}
                  disabled={!pending}
                  onClick={() =>
                    setAnswers((current) => ({ ...current, [question.id]: option.label }))
                  }
                >
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </button>
              ))}
            </div>
          ) : (
            <input
              value={answers[question.id] || ''}
              disabled={!pending}
              onChange={(event) =>
                setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
              }
              placeholder="Type your answer"
            />
          )}
        </div>
      ))}
      {pending ? (
        <div className="agent-interaction-actions">
          <button
            type="button"
            className="agent-interaction-primary"
            disabled={!complete}
            onClick={() => onResolve(interaction.id, answers)}
          >
            Send answer
          </button>
          <button type="button" onClick={() => onResolve(interaction.id, {}, true)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="agent-interaction-status">
          {interaction.status === 'resolved' ? <Check size={12} /> : <X size={12} />}
          {interaction.status === 'resolved' ? 'Answered' : 'Cancelled'}
        </div>
      )}
    </div>
  )
}
