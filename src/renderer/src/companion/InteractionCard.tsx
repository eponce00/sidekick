import { useState } from 'react'
import {
  Check,
  ListChecks,
  Loader2,
  MessageCircleQuestionMark,
  Monitor,
  ShieldAlert,
  X
} from 'lucide-react'
import { agentPermissionDecision, type AgentPermissionDecision } from '../../../shared/permissions'
import {
  EMPTY_ANSWER,
  PERMISSION_DECISION_LABELS,
  answerableOnPhone,
  permissionPreview,
  questionResponse,
  questionsFrom,
  type Interaction,
  type QuestionAnswer
} from './chatState'

export type ResolveInteraction = (
  id: string,
  response: Record<string, unknown>,
  cancelled?: boolean
) => void

interface CardProps {
  interaction: Interaction
  /** The answer was sent and the run has not moved on yet. */
  answered: boolean
  onResolve: ResolveInteraction
}

function CardStatus({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <p className="cp-card-status">
      {ok ? <Check size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
      {children}
    </p>
  )
}

function Sent() {
  return (
    <p className="cp-card-status" role="status">
      <Loader2 size={16} className="icon-spin" aria-hidden="true" />
      Answer sent
    </p>
  )
}

function PermissionCard({ interaction, answered, onResolve }: CardProps) {
  const request = interaction.request
  const title = String(request.title || 'Approve this action?')
  const preview = permissionPreview(request)
  const summary =
    request.preview && typeof request.preview === 'object'
      ? (request.preview as Record<string, unknown>).summary
      : undefined
  // Only requests the runtime could scope offer a chat-wide approval.
  const chatScope = typeof request.chatScope === 'string' ? request.chatScope : ''
  const pending = interaction.status === 'pending'
  const decide = (decision: AgentPermissionDecision): void =>
    onResolve(interaction.id, {
      approved: decision === 'allow_once' || decision === 'allow_chat',
      decision
    })
  const decision =
    interaction.status === 'resolved' ? agentPermissionDecision(interaction.response) : 'deny'
  return (
    <section className={`cp-card${pending ? ' is-pending' : ''}`} aria-label="Permission request">
      <h3 className="cp-card-title">
        <ShieldAlert size={18} aria-hidden="true" />
        <span>{title}</span>
      </h3>
      {pending && typeof summary === 'string' && summary && (
        <p className="cp-card-copy">{summary.slice(0, 600)}</p>
      )}
      {pending && preview && <pre className="cp-card-code">{preview}</pre>}
      {pending ? (
        <>
          <div className="cp-card-actions" role="group" aria-label="Approval">
            <button
              type="button"
              className="cp-button is-primary"
              disabled={answered}
              onClick={() => decide('allow_once')}
            >
              Allow once
            </button>
            {chatScope && (
              <button
                type="button"
                className="cp-button"
                disabled={answered}
                onClick={() => decide('allow_chat')}
              >
                Allow for this chat
              </button>
            )}
            <button
              type="button"
              className="cp-button"
              disabled={answered}
              onClick={() => decide('deny')}
            >
              Deny
            </button>
            <button
              type="button"
              className="cp-button is-danger"
              disabled={answered}
              onClick={() => decide('deny_stop')}
            >
              Deny and stop
            </button>
          </div>
          {answered && <Sent />}
        </>
      ) : (
        <CardStatus ok={decision === 'allow_once' || decision === 'allow_chat'}>
          {PERMISSION_DECISION_LABELS[decision]}
        </CardStatus>
      )}
    </section>
  )
}

function answerText(given: unknown): string | null {
  if (Array.isArray(given)) return given.length ? given.join(', ') : null
  return typeof given === 'string' || typeof given === 'number' ? String(given) : null
}

function QuestionCard({ interaction, answered, onResolve }: CardProps) {
  const questions = questionsFrom(interaction.request)
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({})
  const [index, setIndex] = useState(0)
  const pending = interaction.status === 'pending'

  if (!pending) {
    const cancelled = interaction.status !== 'resolved'
    const summary = cancelled
      ? 'Skipped'
      : questions
          .map((question) => answerText(interaction.response?.[question.id]) ?? 'Skipped')
          .join(' · ') || 'Answered'
    return (
      <section className="cp-card" aria-label="Question">
        <h3 className="cp-card-title">
          <MessageCircleQuestionMark size={18} aria-hidden="true" />
          <span>{questions[0]?.header || questions[0]?.question || 'Question'}</span>
        </h3>
        <CardStatus ok={!cancelled}>{summary}</CardStatus>
      </section>
    )
  }

  const question = questions[Math.min(index, Math.max(questions.length - 1, 0))]
  if (!question) {
    return (
      <section className="cp-card is-pending" aria-label="Question">
        <h3 className="cp-card-title">
          <MessageCircleQuestionMark size={18} aria-hidden="true" />
          <span>Question</span>
        </h3>
        <p className="cp-card-copy">Answer this on the computer.</p>
      </section>
    )
  }
  const answer = answers[question.id] ?? EMPTY_ANSWER
  const last = index >= questions.length - 1
  const hasOptions = Boolean(question.options?.length)
  const allowsText = !hasOptions || question.allowOther !== false
  const update = (
    change: (current: QuestionAnswer) => QuestionAnswer
  ): Record<string, QuestionAnswer> => {
    const next = { ...answers, [question.id]: change(answer) }
    setAnswers(next)
    return next
  }
  // Choosing one answer is the answer; only the last question sends the card.
  const commit = (next: Record<string, QuestionAnswer>): void => {
    if (!last) {
      setIndex(index + 1)
      return
    }
    const response = questionResponse(questions, next)
    if (Object.keys(response).length) onResolve(interaction.id, response)
    else onResolve(interaction.id, {}, true)
  }
  const custom = answer.custom.trim()
  return (
    <section className="cp-card is-pending" aria-label="Question from the agent">
      <div className="cp-card-kicker">
        <span>
          <MessageCircleQuestionMark size={16} aria-hidden="true" />
          {question.header || 'Question'}
        </span>
        {questions.length > 1 && (
          <span>
            {index + 1} of {questions.length}
          </span>
        )}
      </div>
      <p className="cp-question">{question.question}</p>
      {question.multiSelect && hasOptions && <p className="cp-card-hint">Choose any that apply</p>}
      {hasOptions && (
        <div className="cp-options" role="group" aria-label={question.question}>
          {question.options!.map((option) => {
            const selected = answer.selected.includes(option.label)
            return (
              <button
                type="button"
                key={option.label}
                className={`cp-option${selected ? ' is-selected' : ''}`}
                disabled={answered}
                {...(question.multiSelect
                  ? { role: 'checkbox', 'aria-checked': selected }
                  : { 'aria-pressed': selected })}
                onClick={() => {
                  if (question.multiSelect) {
                    update((current) => ({
                      ...current,
                      skipped: false,
                      selected: selected
                        ? current.selected.filter((label) => label !== option.label)
                        : [...current.selected, option.label]
                    }))
                    return
                  }
                  commit(update(() => ({ selected: [option.label], custom: '', skipped: false })))
                }}
              >
                <span className="cp-option-label">
                  {option.label}
                  {option.recommended && <em>Recommended</em>}
                </span>
                {option.description && <small>{option.description}</small>}
              </button>
            )
          })}
        </div>
      )}
      {allowsText && (
        <form
          className="cp-other"
          onSubmit={(event) => {
            event.preventDefault()
            if (!custom || answered) return
            commit(
              update((current) => ({
                ...current,
                skipped: false,
                selected: question.multiSelect ? current.selected : [],
                custom
              }))
            )
          }}
        >
          <input
            value={answer.custom}
            disabled={answered}
            placeholder={hasOptions ? 'Other answer' : 'Type your answer'}
            aria-label={hasOptions ? 'Other answer' : 'Your answer'}
            onChange={(event) => {
              const value = event.target.value
              update((current) => ({ ...current, skipped: false, custom: value }))
            }}
          />
          {(!question.multiSelect || !hasOptions) && (
            <button type="submit" className="cp-button" disabled={!custom || answered}>
              Send
            </button>
          )}
        </form>
      )}
      <div className="cp-card-actions is-row">
        {index > 0 && (
          <button
            type="button"
            className="cp-button is-quiet"
            disabled={answered}
            onClick={() => setIndex(index - 1)}
          >
            Back
          </button>
        )}
        <button
          type="button"
          className="cp-button is-quiet"
          disabled={answered}
          onClick={() => commit(update(() => ({ selected: [], custom: '', skipped: true })))}
        >
          Skip
        </button>
        {question.multiSelect && hasOptions && (
          <button
            type="button"
            className="cp-button is-primary"
            disabled={answered || (!answer.selected.length && !custom)}
            onClick={() => commit(update((current) => ({ ...current, skipped: false })))}
          >
            {last ? 'Done' : 'Next'}
          </button>
        )}
      </div>
      {answered && <Sent />}
    </section>
  )
}

function PlanCard({ interaction, answered, onResolve }: CardProps) {
  const [feedback, setFeedback] = useState('')
  const [revising, setRevising] = useState(false)
  const request = interaction.request
  const entry = request.stage === 'entry'
  const revision = String(request.revision || '')
  const contract =
    request.contract && typeof request.contract === 'object'
      ? (request.contract as Record<string, unknown>)
      : null
  const steps = Array.isArray(contract?.steps)
    ? (contract.steps as unknown[])
        .map((step) =>
          step && typeof step === 'object'
            ? String((step as Record<string, unknown>).title || '')
            : ''
        )
        .filter(Boolean)
    : []
  const summary = entry
    ? String(request.reason || 'This request would benefit from planning first.')
    : String(contract?.summary || contract?.objective || '')
  const pending = interaction.status === 'pending'
  const action = String(interaction.response?.action || '')
  return (
    <section className={`cp-card${pending ? ' is-pending' : ''}`} aria-label="Plan">
      <h3 className="cp-card-title">
        <ListChecks size={18} aria-hidden="true" />
        <span>{entry ? 'Switch to Plan mode?' : String(contract?.title || 'Review plan')}</span>
      </h3>
      {pending && summary && <p className="cp-card-copy">{summary}</p>}
      {pending && steps.length > 0 && (
        <ol className="cp-plan-steps">
          {steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      )}
      {pending && revising && (
        <textarea
          className="cp-plan-feedback"
          value={feedback}
          disabled={answered}
          placeholder="What should change in the plan?"
          aria-label="What should change in the plan?"
          onChange={(event) => setFeedback(event.target.value)}
        />
      )}
      {pending ? (
        <>
          <div className="cp-card-actions">
            <button
              type="button"
              className="cp-button is-primary"
              disabled={answered}
              onClick={() =>
                onResolve(interaction.id, {
                  action: 'approve',
                  approved: true,
                  ...(revision ? { revision } : {})
                })
              }
            >
              {entry ? 'Plan first' : 'Implement plan'}
            </button>
            {!entry && (
              <button
                type="button"
                className="cp-button"
                disabled={answered || (revising && !feedback.trim())}
                onClick={() => {
                  if (!revising) setRevising(true)
                  else
                    onResolve(interaction.id, {
                      action: 'revise',
                      revision,
                      feedback: feedback.trim()
                    })
                }}
              >
                {revising ? 'Send changes' : 'Request changes'}
              </button>
            )}
            <button
              type="button"
              className="cp-button"
              disabled={answered}
              onClick={() =>
                onResolve(interaction.id, { action: 'keep', ...(revision ? { revision } : {}) })
              }
            >
              {entry ? 'Keep working' : 'Keep plan only'}
            </button>
          </div>
          {answered && <Sent />}
        </>
      ) : (
        <CardStatus ok={action === 'approve'}>
          {action === 'approve'
            ? entry
              ? 'Plan mode approved'
              : 'Plan approved'
            : action === 'revise'
              ? 'Changes requested'
              : entry
                ? 'Kept working'
                : 'Plan kept without implementation'}
        </CardStatus>
      )}
    </section>
  )
}

export function InteractionCard(props: CardProps) {
  const { interaction } = props
  if (!answerableOnPhone(interaction)) {
    return (
      <section className="cp-card" aria-label="Needs the computer">
        <h3 className="cp-card-title">
          <Monitor size={18} aria-hidden="true" />
          <span>
            {interaction.request.intent === 'browser_takeover'
              ? 'Browser step on the computer'
              : 'Start sessions'}
          </span>
        </h3>
        <p className="cp-card-copy">
          {interaction.status === 'pending' ? 'Answer this on the computer.' : 'Answered.'}
        </p>
      </section>
    )
  }
  if (interaction.kind === 'permission') return <PermissionCard {...props} />
  if (interaction.kind === 'plan_approval') return <PlanCard {...props} />
  return <QuestionCard {...props} />
}
