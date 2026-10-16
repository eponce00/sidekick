import { useEffect, useState } from 'react'
import { Loader2, Workflow } from 'lucide-react'
import type { ToolExecution } from '../types/chat.types'
import type { SessionProposal } from '../../../shared/sessions'
import './SessionCards.css'

interface SuggestedChat {
  id: string
  title: string
}

function suggestionsFrom(tool: ToolExecution): {
  conversationId: string | null
  suggested: SuggestedChat[]
} {
  const data = tool.data as { suggested?: unknown; conversationId?: unknown } | undefined
  const suggested = Array.isArray(data?.suggested)
    ? data.suggested.filter(
        (item): item is SuggestedChat =>
          Boolean(item) && typeof item.id === 'string' && typeof item.title === 'string'
      )
    : []
  return {
    conversationId: typeof data?.conversationId === 'string' ? data.conversationId : null,
    suggested
  }
}

/** Chats an agent suggested but did not start: each one starts only when the user says so. */
export function SessionProposalsCard({ tool }: { tool: ToolExecution }): React.JSX.Element | null {
  const { conversationId, suggested } = suggestionsFrom(tool)
  const [proposals, setProposals] = useState<Record<string, SessionProposal>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!conversationId) return undefined
    let current = true
    const load = (): void => {
      void window.api.sessions
        .proposals(conversationId)
        .then((list) => {
          if (current) setProposals(Object.fromEntries(list.map((item) => [item.id, item])))
        })
        .catch(() => undefined)
    }
    load()
    const unsubscribe = window.api.sessions.onChanged((change) => {
      if (change.kind === 'proposals' && change.conversationIds.includes(conversationId)) load()
    })
    return () => {
      current = false
      unsubscribe()
    }
  }, [conversationId])

  if (!suggested.length) return null

  const act = async (id: string, action: 'start' | 'dismiss'): Promise<void> => {
    setBusy(id)
    setError('')
    try {
      if (action === 'start') await window.api.sessions.startProposal(id)
      else await window.api.sessions.dismissProposal(id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That did not work.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="session-proposals">
      {suggested.map(({ id, title }) => {
        const status = proposals[id]?.status ?? 'open'
        const brief = proposals[id]?.spec.brief
        return (
          <div className={`session-proposal is-${status}`} key={id}>
            <Workflow size={14} aria-hidden="true" />
            <span className="session-proposal-text">
              <strong>Suggested chat: {title}</strong>
              {brief && <span title={brief}>{brief}</span>}
            </span>
            {status === 'open' ? (
              <span className="session-proposal-actions">
                <button
                  type="button"
                  disabled={busy === id}
                  onClick={() => void act(id, 'dismiss')}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="agent-interaction-primary"
                  disabled={busy === id}
                  onClick={() => void act(id, 'start')}
                >
                  {busy === id && <Loader2 size={13} className="icon-spin" aria-hidden="true" />}
                  Start
                </button>
              </span>
            ) : (
              <span className="session-proposal-status">
                {status === 'started'
                  ? 'Started'
                  : status === 'dismissed'
                    ? 'Dismissed'
                    : 'Expired'}
              </span>
            )}
          </div>
        )
      })}
      {error && (
        <p className="session-proposal-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
