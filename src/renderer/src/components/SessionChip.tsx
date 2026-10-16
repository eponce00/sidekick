import type { SessionState } from '../../../shared/sessions'
import { sessionStateLabel } from '../utils/sessionLabels'
import './ChatFamily.css'

/** The dot every family surface uses, so a state reads the same in a chip, row or panel. */
export function SessionStateDot({ state }: { state: SessionState }): React.JSX.Element {
  return <span className={`session-dot session-dot-${state}`} aria-hidden="true" />
}

interface SessionChipProps {
  name: string
  state: SessionState
  /** Shows the state after the name, as "schedules · Needs you". */
  showState?: boolean
  /** Another project's name, for a worker outside the manager's project. */
  projectTag?: string | null
  onOpen?: () => void
}

/** A chat in its family: a live dot and its handle, opening the chat when it can. */
export function SessionChip({
  name,
  state,
  showState = false,
  projectTag,
  onOpen
}: SessionChipProps): React.JSX.Element {
  const label = `${name}, ${sessionStateLabel(state).toLowerCase()}`
  const content = (
    <>
      <SessionStateDot state={state} />
      <span className="session-chip-name">{name}</span>
      {showState && (
        <span className={`session-chip-state session-chip-state-${state}`}>
          {sessionStateLabel(state)}
        </span>
      )}
      {projectTag && <span className="session-chip-project">{projectTag}</span>}
    </>
  )
  return onOpen ? (
    <button
      type="button"
      className="session-chip"
      onClick={onOpen}
      aria-label={`Open ${label}`}
      title={`Open ${name}`}
    >
      {content}
    </button>
  ) : (
    <span className="session-chip" aria-label={label} role="group">
      {content}
    </span>
  )
}
