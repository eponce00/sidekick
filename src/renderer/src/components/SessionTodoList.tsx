import { CheckCircle2, Circle, CircleAlert, CircleX, LoaderCircle } from 'lucide-react'
import type { SessionFamilyMember, SessionState, SessionStatus } from '../../../shared/sessions'
import type { TodoItem } from '../../../shared/types'
import { familyProjectTag, memberName, memberState } from '../hooks/useSessionFamily'
import { SessionChip } from './SessionChip'
import './ChatFamily.css'

type StepMark = TodoItem['status'] | 'failed' | 'waiting'

const STATUS_LABELS: Record<StepMark, string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  completed: 'Done',
  failed: 'Failed',
  waiting: 'Needs you'
}

/**
 * A delegated step is as far along as the chat doing it says. A chat that only says it is idle
 * (a finished chat once its completion is read, for one) keeps the list's own status.
 */
function delegatedMark(state: SessionState, fallback: TodoItem['status']): StepMark {
  if (state === 'done') return 'completed'
  if (state === 'failed') return 'failed'
  if (state === 'working') return 'in-progress'
  if (state === 'waiting') return 'waiting'
  return fallback
}

function StepIcon({ status }: { status: StepMark }): React.JSX.Element {
  if (status === 'completed') return <CheckCircle2 size={15} aria-hidden="true" />
  if (status === 'failed') return <CircleX size={15} aria-hidden="true" />
  if (status === 'waiting') return <CircleAlert size={15} aria-hidden="true" />
  if (status === 'in-progress')
    return <LoaderCircle size={15} className="icon-spin" aria-hidden="true" />
  return <Circle size={15} strokeDasharray="3 3" aria-hidden="true" />
}

/**
 * A manager's task list, pinned under its latest reply. A step handed to another chat carries
 * that chat's chip, so the list says at a glance which steps are waiting on whom.
 */
export function SessionTodoList({
  todos,
  members,
  statuses,
  manager,
  onOpenChat
}: {
  todos: TodoItem[]
  members: Map<string, SessionFamilyMember>
  statuses: Map<string, SessionStatus>
  manager: SessionFamilyMember | null
  onOpenChat: (conversationId: string) => void
}): React.JSX.Element | null {
  if (!todos.length) return null
  const steps = todos.map((todo) => {
    const member = todo.sessionId ? members.get(todo.sessionId) : undefined
    const state = member ? memberState(member, statuses) : undefined
    return { todo, member, state, mark: state ? delegatedMark(state, todo.status) : todo.status }
  })
  const done = steps.filter((step) => step.mark === 'completed').length
  const elsewhere = steps.filter((step) => step.member).length
  return (
    <section className="family-todos" aria-label="Task list">
      <ol>
        {steps.map(({ todo, member, state, mark }, index) => {
          return (
            <li key={`${todo.id}-${index}`} className={`family-todo is-${mark}`}>
              <span className="family-todo-icon" title={STATUS_LABELS[mark]}>
                <StepIcon status={mark} />
              </span>
              <span className="family-todo-copy">
                <span className="family-todo-title" title={todo.title}>
                  <span className="family-visually-hidden">{STATUS_LABELS[mark]}: </span>
                  {todo.title}
                </span>
                {member && (
                  <SessionChip
                    name={memberName(member)}
                    state={state ?? member.state}
                    showState
                    projectTag={familyProjectTag(member, manager)}
                    onOpen={() => onOpenChat(member.conversationId)}
                  />
                )}
              </span>
            </li>
          )
        })}
      </ol>
      <footer>
        {todos.length} {todos.length === 1 ? 'step' : 'steps'} · {done} done
        {elsewhere > 0 && ` · ${elsewhere} in other chats`}
      </footer>
    </section>
  )
}
