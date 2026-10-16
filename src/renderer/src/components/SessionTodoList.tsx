import { CheckCircle2, Circle, LoaderCircle } from 'lucide-react'
import type { SessionFamilyMember, SessionStatus } from '../../../shared/sessions'
import type { TodoItem } from '../../../shared/types'
import { familyProjectTag, memberName, memberState } from '../hooks/useSessionFamily'
import { SessionChip } from './SessionChip'
import './ChatFamily.css'

const STATUS_LABELS: Record<TodoItem['status'], string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  completed: 'Done'
}

function StepIcon({ status }: { status: TodoItem['status'] }): React.JSX.Element {
  if (status === 'completed') return <CheckCircle2 size={15} aria-hidden="true" />
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
  const done = todos.filter((todo) => todo.status === 'completed').length
  const elsewhere = todos.filter((todo) => todo.sessionId && members.has(todo.sessionId)).length
  return (
    <section className="family-todos" aria-label="Task list">
      <ol>
        {todos.map((todo, index) => {
          const member = todo.sessionId ? members.get(todo.sessionId) : undefined
          return (
            <li key={`${todo.id}-${index}`} className={`family-todo is-${todo.status}`}>
              <span className="family-todo-icon" title={STATUS_LABELS[todo.status]}>
                <StepIcon status={todo.status} />
              </span>
              <span className="family-todo-copy">
                <span className="family-todo-title">
                  <span className="family-visually-hidden">{STATUS_LABELS[todo.status]}: </span>
                  {todo.title}
                </span>
                {member && (
                  <SessionChip
                    name={memberName(member)}
                    state={memberState(member, statuses)}
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
