import { useMemo, useState } from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ListChecks,
  Loader2,
  MonitorUp,
  ShieldAlert,
  X
} from 'lucide-react'
import type { ContentSegment } from '../types/chat.types'

type Interaction = NonNullable<ContentSegment['interaction']>

interface AgentInteractionCardProps {
  interaction: Interaction
  onResolve: (
    id: string,
    response: Record<string, unknown>,
    cancelled?: boolean
  ) => void | Promise<void>
}

interface QuestionOption {
  label: string
  description?: string
  recommended?: boolean
}

interface Question {
  id: string
  header?: string
  question: string
  options?: QuestionOption[]
  multiSelect?: boolean
  allowOther?: boolean
}

interface QuestionAnswer {
  selected: string[]
  custom: string
  skipped: boolean
}

const EMPTY_ANSWER: QuestionAnswer = { selected: [], custom: '', skipped: false }

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
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({})
  const [questionIndex, setQuestionIndex] = useState(0)
  const [showOther, setShowOther] = useState<Record<string, boolean>>({})
  const [planFeedback, setPlanFeedback] = useState('')
  const [showPlanFeedback, setShowPlanFeedback] = useState(false)
  const [takeoverState, setTakeoverState] = useState<'idle' | 'opening' | 'active' | 'checking'>(
    'idle'
  )
  const [takeoverError, setTakeoverError] = useState('')
  const [takeoverUrl, setTakeoverUrl] = useState('')
  const pending = interaction.status === 'pending'
  const [permissionSubmission, setPermissionSubmission] = useState<{
    interactionId: string
    approved: boolean
    settled: boolean
  } | null>(null)

  if (interaction.kind === 'permission') {
    const title = String(interaction.request.title || 'Approve this action?')
    const detail = interaction.request.arguments
      ? JSON.stringify(interaction.request.arguments, null, 2).slice(0, 3_000)
      : ''
    const localSubmission =
      permissionSubmission?.interactionId === interaction.id ? permissionSubmission : null
    const displayedDecision = pending
      ? localSubmission?.approved
      : interaction.response?.approved === true
    const resolving = pending && Boolean(localSubmission && !localSubmission.settled)
    const locallySettled = pending && localSubmission?.settled === true
    const resolvePermission = async (approved: boolean): Promise<void> => {
      if (localSubmission) return
      setPermissionSubmission({ interactionId: interaction.id, approved, settled: false })
      try {
        // A denial is a resolved policy decision, not a cancelled interaction.
        await onResolve(interaction.id, { approved })
        // The durable event remains authoritative for replay, but a successful IPC response means
        // the engine accepted the decision. Do not leave the card spinning while projection catches up.
        setPermissionSubmission({ interactionId: interaction.id, approved, settled: true })
      } catch {
        setPermissionSubmission(null)
      }
    }
    return (
      <div
        className={`agent-interaction agent-interaction-permission agent-interaction-${resolving ? 'resolving' : locallySettled ? 'resolved' : interaction.status}`}
      >
        <div className="agent-interaction-heading">
          <ShieldAlert size={14} aria-hidden="true" />
          <span>{title}</span>
        </div>
        {detail && pending && !resolving && (
          <details className="agent-interaction-detail-disclosure">
            <summary>Review action details</summary>
            <pre className="agent-interaction-detail">{detail}</pre>
          </details>
        )}
        {pending && !localSubmission ? (
          <div className="agent-interaction-actions">
            <button
              type="button"
              className="agent-interaction-primary"
              onClick={() => void resolvePermission(true)}
            >
              Approve
            </button>
            <button type="button" onClick={() => void resolvePermission(false)}>
              Deny
            </button>
          </div>
        ) : (
          <div className="agent-interaction-status">
            {resolving ? (
              <Loader2 size={12} className="icon-spin" />
            ) : displayedDecision ? (
              <Check size={12} />
            ) : (
              <X size={12} />
            )}
            {resolving
              ? displayedDecision
                ? 'Approving…'
                : 'Denying…'
              : displayedDecision
                ? 'Approved'
                : 'Denied'}
          </div>
        )}
      </div>
    )
  }

  if (interaction.kind === 'question' && interaction.request.intent === 'browser_takeover') {
    const reason = String(
      interaction.request.reason || 'This site needs a human-only browser step before continuing.'
    )
    const completed = interaction.response?.completed === true
    const beginTakeover = async (): Promise<void> => {
      setTakeoverError('')
      setTakeoverState('opening')
      try {
        const snapshot = await window.api.agentRuns.beginBrowserHumanTakeover(interaction.id)
        setTakeoverUrl(snapshot.url)
        setTakeoverState(snapshot.active ? 'active' : 'idle')
        if (!snapshot.active) setTakeoverError('The browser window could not be opened.')
      } catch (error) {
        setTakeoverState('idle')
        setTakeoverError(error instanceof Error ? error.message : 'Could not open the browser.')
      }
    }
    const completeTakeover = async (): Promise<void> => {
      setTakeoverError('')
      setTakeoverState('checking')
      try {
        const snapshot = await window.api.agentRuns.completeBrowserHumanTakeover(interaction.id)
        setTakeoverUrl(snapshot.url)
        if (snapshot.humanVerificationRequired) {
          setTakeoverState('idle')
          setTakeoverError(
            snapshot.message ||
              'Human verification is still visible. Take control again and finish the step.'
          )
          return
        }
        await onResolve(interaction.id, { completed: true })
      } catch (error) {
        setTakeoverState('idle')
        setTakeoverError(
          error instanceof Error ? error.message : 'Could not verify the browser state.'
        )
      }
    }
    const continueWithoutTakeover = async (): Promise<void> => {
      if (takeoverState === 'active') {
        await window.api.agentRuns
          .completeBrowserHumanTakeover(interaction.id)
          .catch(() => undefined)
      }
      await onResolve(interaction.id, { completed: false })
    }
    return (
      <div
        className={`agent-interaction agent-interaction-browser-takeover agent-interaction-${interaction.status}`}
      >
        <div className="agent-interaction-heading">
          <MonitorUp size={14} aria-hidden="true" />
          <span>Human browser verification required</span>
        </div>
        <div className="agent-interaction-copy">{reason}</div>
        {takeoverUrl && (
          <div className="agent-browser-takeover-url" title={takeoverUrl}>
            {takeoverUrl}
          </div>
        )}
        {takeoverError && <div className="agent-browser-takeover-error">{takeoverError}</div>}
        {pending ? (
          <div className="agent-interaction-actions">
            {takeoverState === 'active' ? (
              <button
                type="button"
                className="agent-interaction-primary"
                onClick={() => void completeTakeover()}
              >
                I’ve finished — resume
              </button>
            ) : (
              <button
                type="button"
                className="agent-interaction-primary"
                disabled={takeoverState === 'opening' || takeoverState === 'checking'}
                onClick={() => void beginTakeover()}
              >
                {takeoverState === 'opening' ? (
                  <>
                    <Loader2 size={12} className="icon-spin" /> Opening browser…
                  </>
                ) : takeoverState === 'checking' ? (
                  <>
                    <Loader2 size={12} className="icon-spin" /> Checking…
                  </>
                ) : (
                  'Take control'
                )}
              </button>
            )}
            <button
              type="button"
              disabled={takeoverState === 'opening' || takeoverState === 'checking'}
              onClick={() => void continueWithoutTakeover()}
            >
              Use another source
            </button>
          </div>
        ) : (
          <div className="agent-interaction-status">
            {completed ? <Check size={12} /> : <X size={12} />}
            {completed ? 'Verification completed' : 'Continued without verification'}
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

  const currentQuestion = questions[Math.min(questionIndex, Math.max(questions.length - 1, 0))]
  const currentAnswer = currentQuestion
    ? (answers[currentQuestion.id] ?? EMPTY_ANSWER)
    : EMPTY_ANSWER
  const hasCurrentAnswer =
    currentAnswer.skipped ||
    currentAnswer.selected.length > 0 ||
    Boolean(currentAnswer.custom.trim())
  const atLastQuestion = questionIndex >= questions.length - 1
  const setQuestionAnswer = (
    id: string,
    update: (current: QuestionAnswer) => QuestionAnswer
  ): void => {
    setAnswers((current) => ({ ...current, [id]: update(current[id] ?? EMPTY_ANSWER) }))
  }
  const responseAnswers = (): Record<string, unknown> =>
    Object.fromEntries(
      questions.flatMap((question) => {
        const answer = answers[question.id] ?? EMPTY_ANSWER
        if (answer.skipped) return []
        const values = [...answer.selected, ...(answer.custom.trim() ? [answer.custom.trim()] : [])]
        if (!values.length) return []
        return [[question.id, question.multiSelect || values.length > 1 ? values : values[0]]]
      })
    )
  return (
    <div
      className={`agent-interaction agent-interaction-question agent-interaction-${interaction.status}`}
    >
      {pending && questions.length > 1 && (
        <div className="agent-question-progress">
          <span>
            Question {questionIndex + 1} of {questions.length}
          </span>
          <span>
            {questions.map((question, index) => (
              <i
                key={question.id}
                className={
                  index === questionIndex ? 'active' : answers[question.id] ? 'answered' : ''
                }
              />
            ))}
          </span>
        </div>
      )}
      {pending && currentQuestion ? (
        <div className="agent-question" key={currentQuestion.id}>
          {currentQuestion.header && (
            <div className="agent-question-header">{currentQuestion.header}</div>
          )}
          <div className="agent-question-copy">{currentQuestion.question}</div>
          {currentQuestion.options?.length ? (
            <div className="agent-question-options">
              {currentQuestion.options.map((option) => {
                const selected = currentAnswer.selected.includes(option.label)
                return (
                  <button
                    type="button"
                    key={option.label}
                    className={selected ? 'selected' : ''}
                    aria-pressed={selected}
                    onClick={() =>
                      setQuestionAnswer(currentQuestion.id, (answer) => ({
                        ...answer,
                        skipped: false,
                        selected: currentQuestion.multiSelect
                          ? selected
                            ? answer.selected.filter((value) => value !== option.label)
                            : [...answer.selected, option.label]
                          : [option.label]
                      }))
                    }
                  >
                    <span>
                      {option.label}
                      {option.recommended && <em>Recommended</em>}
                    </span>
                    {option.description && <small>{option.description}</small>}
                  </button>
                )
              })}
              {currentQuestion.allowOther !== false &&
                (showOther[currentQuestion.id] ? (
                  <input
                    value={currentAnswer.custom}
                    autoFocus
                    onChange={(event) =>
                      setQuestionAnswer(currentQuestion.id, (answer) => ({
                        ...answer,
                        skipped: false,
                        custom: event.target.value
                      }))
                    }
                    placeholder="Type another answer"
                  />
                ) : (
                  <button
                    type="button"
                    className="agent-question-other"
                    onClick={() =>
                      setShowOther((current) => ({ ...current, [currentQuestion.id]: true }))
                    }
                  >
                    <span>Something else…</span>
                  </button>
                ))}
            </div>
          ) : (
            <input
              value={currentAnswer.custom}
              autoFocus
              onChange={(event) =>
                setQuestionAnswer(currentQuestion.id, (answer) => ({
                  ...answer,
                  skipped: false,
                  custom: event.target.value
                }))
              }
              placeholder="Type your answer"
            />
          )}
        </div>
      ) : null}
      {pending ? (
        <div className="agent-interaction-actions agent-question-navigation">
          {questionIndex > 0 && (
            <button type="button" onClick={() => setQuestionIndex((current) => current - 1)}>
              <ChevronLeft size={13} /> Back
            </button>
          )}
          {currentQuestion && (
            <button
              type="button"
              onClick={() => {
                setQuestionAnswer(currentQuestion.id, (answer) => ({
                  ...answer,
                  selected: [],
                  custom: '',
                  skipped: true
                }))
                if (!atLastQuestion) setQuestionIndex((current) => current + 1)
                else {
                  const response = responseAnswers()
                  delete response[currentQuestion.id]
                  void onResolve(interaction.id, response)
                }
              }}
            >
              Skip
            </button>
          )}
          <button
            type="button"
            className="agent-interaction-primary"
            disabled={!hasCurrentAnswer}
            onClick={() =>
              atLastQuestion
                ? onResolve(interaction.id, responseAnswers())
                : setQuestionIndex((current) => current + 1)
            }
          >
            {atLastQuestion ? (
              'Send answers'
            ) : (
              <>
                Next <ChevronRight size={13} />
              </>
            )}
          </button>
          <button
            type="button"
            className="agent-question-cancel"
            onClick={() => onResolve(interaction.id, {}, true)}
          >
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
