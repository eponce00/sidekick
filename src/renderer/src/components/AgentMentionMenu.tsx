import { AtSign } from 'lucide-react'
import type { AgentMentionCandidate } from '../utils/agentMentions'

interface AgentMentionMenuProps {
  id: string
  candidates: AgentMentionCandidate[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (candidate: AgentMentionCandidate) => void
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
}

export function AgentMentionMenu({
  id,
  candidates,
  activeIndex,
  onActiveIndexChange,
  onSelect
}: AgentMentionMenuProps): React.JSX.Element {
  return (
    <div
      id={id}
      className="group-mention-menu"
      role="listbox"
      aria-label="Available project agents"
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="group-mention-heading">
        <span>
          <AtSign size={13} /> Tag an agent
        </span>
        <kbd>↑↓</kbd>
      </div>
      <div className="group-mention-options">
        {candidates.length ? (
          candidates.map((candidate, index) => (
            <button
              id={`${id}-option-${candidate.id}`}
              key={candidate.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`group-mention-option ${index === activeIndex ? 'active' : ''}`}
              onMouseEnter={() => onActiveIndexChange(index)}
              onClick={() => onSelect(candidate)}
            >
              <span className="group-mention-avatar">{initials(candidate.label)}</span>
              <span className="group-mention-copy">
                <strong>{candidate.label}</strong>
                <small>{candidate.projectName}</small>
              </span>
              <span className="group-mention-token">@{candidate.label}</span>
            </button>
          ))
        ) : (
          <div className="group-mention-empty">No matching agents</div>
        )}
      </div>
    </div>
  )
}
