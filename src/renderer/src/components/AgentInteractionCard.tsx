import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Check,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ListChecks,
  Loader2,
  MessageCircleQuestionMark,
  MonitorUp,
  ShieldAlert,
  X
} from 'lucide-react'
import type { ContentSegment } from '../types/chat.types'
import { agentPermissionDecision, type AgentPermissionDecision } from '../../../shared/permissions'
import { useWorkerChatIdentity } from './sessionChatContext'

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

const PERMISSION_DECISION_LABELS: Record<AgentPermissionDecision, string> = {
  allow_once: 'Allowed once',
  allow_chat: 'Allowed for this chat',
  deny: 'Denied',
  deny_stop: 'Denied and stopped'
}

/**
 * A typed answer behaves like the composer it sits above: the same field, the
 * same round send button, Enter to send. Nothing else in the card needs a
 * submit control, so this is the only place one appears.
 */
function QuestionCompose({
  value,
  placeholder,
  onChange,
  onSend
}: {
  value: string
  placeholder: string
  onChange: (value: string) => void
  onSend: (value: string) => void
}): React.JSX.Element {
  const trimmed = value.trim()
  const send = (): void => {
    if (trimmed) onSend(trimmed)
  }
  return (
    <div className="agent-question-compose field-shell">
      <input
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey) return
          event.preventDefault()
          send()
        }}
      />
      <button
        type="button"
        className="send-button agent-question-send"
        onClick={send}
        disabled={!trimmed}
        aria-label="Send answer"
        title="Send answer"
      >
        <ArrowUp size={13} strokeWidth={2.4} />
      </button>
    </div>
  )
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

function answerText(given: unknown): string | null {
  if (Array.isArray(given)) return given.length ? given.join(', ') : null
  return typeof given === 'string' || typeof given === 'number' ? String(given) : null
}

/**
 * Once answered, a question is part of the conversation's history rather than
 * something to act on, so it folds to one row like a finished tool call: what
 * was asked, then what the user chose. The full exchange is one click away.
 */
function AnsweredQuestions({
  interaction,
  questions
}: {
  interaction: Interaction
  questions: Question[]
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const cancelled = interaction.status !== 'resolved'
  const answered = questions.map((question) => ({
    question,
    answer: cancelled ? null : answerText(interaction.response?.[question.id])
  }))
  const label =
    questions.length === 1
      ? questions[0].header || questions[0].question
      : questions.length > 1
        ? `${questions.length} questions`
        : 'Question'
  const value = cancelled
    ? 'Cancelled'
    : answered.length
      ? answered.map(({ answer }) => answer ?? 'Skipped').join(' · ')
      : 'Answered'
  const expandable = questions.length > 0
  return (
    <div
      className={`agent-interaction agent-interaction-question agent-interaction-${interaction.status}`}
    >
      <button
        type="button"
        className="agent-question-answered"
        aria-label={`${label}, ${cancelled ? 'cancelled' : `answered: ${value}`}`}
        aria-expanded={expandable ? expanded : undefined}
        aria-controls={expandable && expanded ? detailsId : undefined}
        disabled={!expandable}
        title={`${label} → ${value}`}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="agent-question-answered-icon" aria-hidden="true">
          {cancelled ? <X size={14} /> : <MessageCircleQuestionMark size={14} />}
        </span>
        <span className="agent-question-answered-label">{label}</span>
        <span className="agent-question-answered-arrow" aria-hidden="true">
          →
        </span>
        <span className={`agent-question-answered-value${cancelled ? ' is-cancelled' : ''}`}>
          {value}
        </span>
        {expandable && (
          <span
            className={`agent-question-answered-chevron${expanded ? ' is-expanded' : ''}`}
            aria-hidden="true"
          >
            <ChevronRight size={14} />
          </span>
        )}
      </button>
      {expandable && expanded && (
        <dl className="agent-question-summary" id={detailsId}>
          {answered.map(({ question, answer }) => (
            <div key={question.id}>
              <dt>{question.question}</dt>
              <dd className={answer ? '' : 'is-skipped'}>
                {answer ?? (cancelled ? 'Not answered' : 'Skipped')}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

/**
 * Arrow keys walk the choices and the field below them, and a digit picks the
 * matching choice, so a question can be answered without leaving the keyboard.
 * A digit typed into the field stays text.
 */
function handleOptionKeys(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  const inField = event.target instanceof HTMLInputElement
  const stops = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('.agent-question-option, input')
  ]
  const index = stops.indexOf(document.activeElement as HTMLElement)
  const move = (to: number): void => {
    event.preventDefault()
    stops[(to + stops.length) % stops.length]?.focus()
  }
  if (event.key === 'ArrowUp' || (!inField && event.key === 'ArrowLeft')) move(index - 1)
  else if (!inField && (event.key === 'ArrowDown' || event.key === 'ArrowRight')) move(index + 1)
  else if (!inField && /^[1-9]$/.test(event.key)) {
    const option =
      event.currentTarget.querySelectorAll<HTMLButtonElement>('.agent-question-option')[
        Number(event.key) - 1
      ]
    if (!option) return
    event.preventDefault()
    option.focus()
    option.click()
  }
}

export default function AgentInteractionCard({
  interaction,
  onResolve
}: AgentInteractionCardProps): React.JSX.Element {
  const questions = useMemo(() => questionsFrom(interaction), [interaction])
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({})
  const [questionIndex, setQuestionIndex] = useState(0)
  const [planFeedback, setPlanFeedback] = useState('')
  const [showPlanFeedback, setShowPlanFeedback] = useState(false)
  const [takeoverState, setTakeoverState] = useState<'idle' | 'opening' | 'active' | 'checking'>(
    'idle'
  )
  const [takeoverError, setTakeoverError] = useState('')
  const [takeoverUrl, setTakeoverUrl] = useState('')
  const pending = interaction.status === 'pending'
  const workerIdentity = useWorkerChatIdentity()
  const questionRef = useRef<HTMLDivElement>(null)
  const questionShownRef = useRef(false)
  const promptId = useId()
  // Answering replaces the focused control, so focus follows to the next
  // question. The first question takes focus only when nothing else has it,
  // never from a message the user is typing.
  useEffect(() => {
    const root = questionRef.current
    if (!pending || !root) return
    const advanced = questionShownRef.current
    questionShownRef.current = true
    const active = document.activeElement
    if (!advanced && active && active !== document.body) return
    const target =
      root.querySelector<HTMLElement>(
        '.agent-question-option.selected, .agent-question-option[aria-current="true"]'
      ) ?? root.querySelector<HTMLElement>('.agent-question-option, input')
    target?.focus()
  }, [pending, questionIndex])
  const [permissionSubmission, setPermissionSubmission] = useState<{
    interactionId: string
    decision: AgentPermissionDecision
    settled: boolean
  } | null>(null)

  if (interaction.kind === 'permission') {
    const title = String(interaction.request.title || 'Approve this action?')
    const detail = interaction.request.arguments
      ? JSON.stringify(interaction.request.arguments, null, 2).slice(0, 3_000)
      : ''
    // Only requests the runtime could scope offer a chat-wide approval.
    const chatScope =
      typeof interaction.request.chatScope === 'string' ? interaction.request.chatScope : ''
    const localSubmission =
      permissionSubmission?.interactionId === interaction.id ? permissionSubmission : null
    const displayedDecision: AgentPermissionDecision | null = pending
      ? (localSubmission?.decision ?? null)
      : interaction.status === 'resolved'
        ? agentPermissionDecision(interaction.response)
        : 'deny'
    const approved = displayedDecision === 'allow_once' || displayedDecision === 'allow_chat'
    const resolving = pending && Boolean(localSubmission && !localSubmission.settled)
    const locallySettled = pending && localSubmission?.settled === true
    const resolvePermission = async (decision: AgentPermissionDecision): Promise<void> => {
      if (localSubmission) return
      setPermissionSubmission({ interactionId: interaction.id, decision, settled: false })
      try {
        // A denial is a resolved policy decision, not a cancelled interaction.
        await onResolve(interaction.id, {
          approved: decision === 'allow_once' || decision === 'allow_chat',
          decision
        })
        // The durable event remains authoritative for replay, but a successful IPC response means
        // the engine accepted the decision. Do not leave the card spinning while projection catches up.
        setPermissionSubmission({ interactionId: interaction.id, decision, settled: true })
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
        {workerIdentity && pending && (
          // A worker asks with its own name, its manager's and its workspace, so an approval is
          // never given without knowing which chat wants it.
          <div className="agent-interaction-context">
            <strong>{workerIdentity.workerName}</strong>
            <span>worker of {workerIdentity.managerTitle}</span>
            {workerIdentity.workplace && <span>in {workerIdentity.workplace}</span>}
          </div>
        )}
        {detail && pending && !resolving && (
          <details className="agent-interaction-detail-disclosure">
            <summary>Review action details</summary>
            <pre className="agent-interaction-detail">{detail}</pre>
          </details>
        )}
        {pending && !localSubmission ? (
          <div className="agent-interaction-actions" role="group" aria-label="Approval">
            <button
              type="button"
              className="agent-interaction-primary"
              onClick={() => void resolvePermission('allow_once')}
            >
              Allow once
            </button>
            {chatScope && (
              <button
                type="button"
                title={`Allow ${chatScope} without asking again in this chat until SideKick restarts`}
                onClick={() => void resolvePermission('allow_chat')}
              >
                Allow for this chat
              </button>
            )}
            <button type="button" onClick={() => void resolvePermission('deny')}>
              Deny
            </button>
            <button
              type="button"
              className="agent-interaction-stop"
              title="Deny this action and stop the run"
              onClick={() => void resolvePermission('deny_stop')}
            >
              Deny and stop
            </button>
          </div>
        ) : (
          <div className="agent-interaction-status">
            {resolving ? (
              <Loader2 size={12} className="icon-spin" />
            ) : approved ? (
              <Check size={12} />
            ) : (
              <X size={12} />
            )}
            {resolving
              ? approved
                ? 'Allowing…'
                : 'Denying…'
              : PERMISSION_DECISION_LABELS[displayedDecision ?? 'deny']}
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
  const responseFrom = (source: Record<string, QuestionAnswer>): Record<string, unknown> =>
    Object.fromEntries(
      questions.flatMap((question) => {
        const answer = source[question.id] ?? EMPTY_ANSWER
        if (answer.skipped) return []
        const values = [...answer.selected, ...(answer.custom.trim() ? [answer.custom.trim()] : [])]
        if (!values.length) return []
        return [[question.id, question.multiSelect || values.length > 1 ? values : values[0]]]
      })
    )
  /**
   * Record an answer and move on in the same gesture. A question that accepts
   * one answer needs no separate confirmation: choosing is the answer. Only a
   * question that accumulates several needs a button to say "that is all".
   */
  const commitAnswer = (id: string, update: (current: QuestionAnswer) => QuestionAnswer): void => {
    const next = { ...answers, [id]: update(answers[id] ?? EMPTY_ANSWER) }
    setAnswers(next)
    if (!atLastQuestion) {
      setQuestionIndex((current) => current + 1)
      return
    }
    void onResolve(interaction.id, responseFrom(next))
  }
  if (!pending) return <AnsweredQuestions interaction={interaction} questions={questions} />
  const multiOptions = Boolean(currentQuestion?.multiSelect && currentQuestion.options?.length)
  return (
    <section
      className="agent-interaction agent-interaction-question agent-interaction-pending"
      aria-label={
        questions.length > 1
          ? `Question ${questionIndex + 1} of ${questions.length} from the agent`
          : 'Question from the agent'
      }
    >
      <div className="agent-question-top">
        <span className="agent-question-kicker">
          <MessageCircleQuestionMark size={13} aria-hidden="true" />
          {currentQuestion?.header || 'Question'}
        </span>
        {questions.length > 1 && (
          <span className="agent-question-progress" aria-hidden="true">
            <span className="agent-question-steps">
              {questions.map((question, index) => (
                <i
                  key={question.id}
                  className={
                    index === questionIndex ? 'active' : answers[question.id] ? 'answered' : ''
                  }
                />
              ))}
            </span>
            {questionIndex + 1} of {questions.length}
          </span>
        )}
      </div>
      {currentQuestion ? (
        <div className="agent-question" key={currentQuestion.id} ref={questionRef}>
          <div className="agent-question-copy" id={promptId}>
            {currentQuestion.question}
          </div>
          {multiOptions && <div className="agent-question-hint">Choose any that apply</div>}
          {currentQuestion.options?.length ? (
            <div
              className={`agent-question-options${currentQuestion.multiSelect ? ' is-multi' : ''}`}
              role="group"
              aria-labelledby={promptId}
              onKeyDown={handleOptionKeys}
            >
              {currentQuestion.options.map((option, index) => {
                const selected = currentAnswer.selected.includes(option.label)
                return (
                  <button
                    type="button"
                    key={option.label}
                    className={`agent-question-option${selected ? ' selected' : ''}`}
                    {...(currentQuestion.multiSelect
                      ? { role: 'checkbox', 'aria-checked': selected }
                      : selected
                        ? { 'aria-current': true }
                        : {})}
                    onClick={() =>
                      currentQuestion.multiSelect
                        ? setQuestionAnswer(currentQuestion.id, (answer) => ({
                            ...answer,
                            skipped: false,
                            selected: selected
                              ? answer.selected.filter((value) => value !== option.label)
                              : [...answer.selected, option.label]
                          }))
                        : commitAnswer(currentQuestion.id, (answer) => ({
                            ...answer,
                            skipped: false,
                            custom: '',
                            selected: [option.label]
                          }))
                    }
                  >
                    {/* The number is the key that picks the choice; a tick replaces it once chosen. */}
                    <span className="agent-question-mark" aria-hidden="true">
                      {selected ? <Check size={11} strokeWidth={3} /> : index < 9 ? index + 1 : ''}
                    </span>
                    <span className="agent-question-option-body">
                      <span className="agent-question-option-label">
                        {option.label}
                        {option.recommended && <em>Recommended</em>}
                      </span>
                      {option.description && <small>{option.description}</small>}
                    </span>
                  </button>
                )
              })}
              {currentQuestion.allowOther !== false && (
                <QuestionCompose
                  value={currentAnswer.custom}
                  placeholder="Or write your own answer"
                  onChange={(value) =>
                    setQuestionAnswer(currentQuestion.id, (answer) => ({
                      ...answer,
                      skipped: false,
                      custom: value
                    }))
                  }
                  onSend={(value) =>
                    commitAnswer(currentQuestion.id, (answer) => ({
                      ...answer,
                      skipped: false,
                      selected: [],
                      custom: value
                    }))
                  }
                />
              )}
            </div>
          ) : (
            <QuestionCompose
              value={currentAnswer.custom}
              placeholder="Type your answer"
              onChange={(value) =>
                setQuestionAnswer(currentQuestion.id, (answer) => ({
                  ...answer,
                  skipped: false,
                  custom: value
                }))
              }
              onSend={(value) =>
                commitAnswer(currentQuestion.id, (answer) => ({
                  ...answer,
                  skipped: false,
                  custom: value
                }))
              }
            />
          )}
        </div>
      ) : null}
      <div className="agent-question-footer">
        {questionIndex > 0 && (
          <button type="button" onClick={() => setQuestionIndex((current) => current - 1)}>
            <ChevronLeft size={13} aria-hidden="true" /> Back
          </button>
        )}
        {currentQuestion && (
          <button
            type="button"
            onClick={() =>
              commitAnswer(currentQuestion.id, (answer) => ({
                ...answer,
                selected: [],
                custom: '',
                skipped: true
              }))
            }
          >
            Skip
          </button>
        )}
        {currentQuestion?.multiSelect && (
          <button
            type="button"
            className="agent-question-primary"
            disabled={!hasCurrentAnswer}
            onClick={() =>
              commitAnswer(currentQuestion.id, (answer) => ({ ...answer, skipped: false }))
            }
          >
            {atLastQuestion ? 'Send answers' : 'Next'}
          </button>
        )}
        <button
          type="button"
          className="agent-question-cancel"
          title="Dismiss the question without answering"
          onClick={() => onResolve(interaction.id, {}, true)}
        >
          Cancel
        </button>
      </div>
    </section>
  )
}
