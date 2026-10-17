import { useState } from 'react'
import { Loader2, ShieldCheck, Workflow } from 'lucide-react'
import type { ContentSegment } from '../types/chat.types'
import type {
  SessionWorkIn,
  StartSessionCardRow,
  StartSessionsCardRequest,
  StartSessionsCardResponse
} from '../../../shared/sessions'
import './SessionCards.css'
import { Select } from './Select'

type Interaction = NonNullable<ContentSegment['interaction']>

const WORK_IN_LABELS: Record<SessionWorkIn, string> = {
  worktree: 'New worktree',
  folder: 'This folder, shared',
  'read-only': 'This folder, read-only'
}

function rowsFrom(interaction: Interaction): StartSessionCardRow[] {
  const request = interaction.request as unknown as Partial<StartSessionsCardRequest>
  return Array.isArray(request.sessions) ? request.sessions : []
}

function chatCount(count: number): string {
  return count === 1 ? 'a chat' : `${count} chats`
}

/**
 * Asks before an agent starts other chats: one row per chat, where the user can change its
 * project and where it works, then start them or not. A project the chat may not use yet is
 * allowed by starting.
 */
export function StartSessionsCard({
  interaction,
  onResolve
}: {
  interaction: Interaction
  onResolve: (id: string, response: Record<string, unknown>) => void | Promise<void>
}): React.JSX.Element {
  const rows = rowsFrom(interaction)
  const request = interaction.request as unknown as Partial<StartSessionsCardRequest>
  const projects = Array.isArray(request.projects) ? request.projects : []
  const [changes, setChanges] = useState<NonNullable<StartSessionsCardResponse['sessions']>>(() =>
    rows.map(() => ({}))
  )
  const [submitting, setSubmitting] = useState<'start' | 'cancel' | null>(null)
  const pending = interaction.status === 'pending'
  const response = interaction.response as Partial<StartSessionsCardResponse> | undefined

  const projectOf = (index: number): string | null =>
    changes[index]?.projectId !== undefined
      ? (changes[index].projectId ?? null)
      : rows[index].projectId
  const workInOf = (index: number): SessionWorkIn => changes[index]?.workIn ?? rows[index].workIn
  const newProjects = [
    ...new Set(
      rows
        .map((row, index) => {
          const projectId = projectOf(index)
          const changed = projectId !== row.projectId
          return (changed || row.needsGrant) && projectId
            ? projects.find(({ id }) => id === projectId)?.name
            : undefined
        })
        .filter((name): name is string => Boolean(name))
    )
  ]

  const resolve = async (action: 'start' | 'cancel'): Promise<void> => {
    if (submitting) return
    setSubmitting(action)
    try {
      const answer: StartSessionsCardResponse =
        action === 'start' ? { action, sessions: changes } : { action }
      await onResolve(interaction.id, answer as unknown as Record<string, unknown>)
    } catch {
      setSubmitting(null)
    }
  }

  if (!pending) {
    const started = interaction.status === 'resolved' && response?.action === 'start'
    return (
      <div className={`agent-interaction start-sessions-card is-settled`}>
        <div className="agent-interaction-heading">
          <Workflow size={14} aria-hidden="true" />
          <span>
            {started
              ? `Started ${chatCount(rows.length)}`
              : `Did not start ${chatCount(rows.length)}`}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="agent-interaction start-sessions-card">
      <div className="agent-interaction-heading">
        <Workflow size={14} aria-hidden="true" />
        <span>Start {chatCount(rows.length)}?</span>
      </div>
      <p className="start-sessions-description">
        Each gets its own chat, works without seeing this conversation, and reports back here when
        it goes idle. You can open and talk to any of them.
      </p>
      <div className="start-sessions-rows" role="table" aria-label="Chats to start">
        <div className="start-sessions-row is-header" role="row">
          <span role="columnheader">Chat</span>
          <span role="columnheader">Project</span>
          <span role="columnheader">Works in</span>
          <span role="columnheader">Model</span>
        </div>
        {rows.map((row, index) => (
          <div className="start-sessions-row" role="row" key={`${row.handle}-${index}`}>
            <span className="start-sessions-name" role="cell">
              <strong>{row.handle}</strong>
              <span title={row.brief}>{row.title}</span>
            </span>
            <span role="cell">
              <Select
                aria-label={`Project for ${row.handle}`}
                value={projectOf(index) ?? ''}
                disabled={Boolean(submitting)}
                onChange={(event) =>
                  setChanges((current) =>
                    current.map((change, at) =>
                      at === index ? { ...change, projectId: event.target.value || null } : change
                    )
                  )
                }
              >
                {!row.projectId && <option value="">No project</option>}
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </span>
            <span role="cell">
              <Select
                aria-label={`Where ${row.handle} works`}
                value={workInOf(index)}
                disabled={Boolean(submitting) || !projectOf(index)}
                onChange={(event) =>
                  setChanges((current) =>
                    current.map((change, at) =>
                      at === index
                        ? { ...change, workIn: event.target.value as SessionWorkIn }
                        : change
                    )
                  )
                }
              >
                {(Object.keys(WORK_IN_LABELS) as SessionWorkIn[]).map((value) => (
                  <option key={value} value={value}>
                    {WORK_IN_LABELS[value]}
                  </option>
                ))}
              </Select>
            </span>
            <span className="start-sessions-model" role="cell" title={row.modelName}>
              {row.modelName}
              {row.context === 'fork' && <em> · copies this chat</em>}
            </span>
          </div>
        ))}
      </div>
      <div className="agent-interaction-actions start-sessions-actions">
        <span className="start-sessions-note">
          <ShieldCheck size={13} aria-hidden="true" />
          {newProjects.length
            ? `Same permissions as this chat · starting allows it to use ${newProjects.join(', ')}`
            : 'Same permissions as this chat'}
        </span>
        <button type="button" disabled={Boolean(submitting)} onClick={() => void resolve('cancel')}>
          Not now
        </button>
        <button
          type="button"
          className="agent-interaction-primary"
          disabled={Boolean(submitting)}
          onClick={() => void resolve('start')}
        >
          {submitting === 'start' && <Loader2 size={13} className="icon-spin" aria-hidden="true" />}
          Start {chatCount(rows.length)}
        </button>
      </div>
    </div>
  )
}
