export interface AgentMentionCandidate {
  id: string
  label: string
  projectName: string
}

export interface ActiveAgentMention {
  start: number
  end: number
  query: string
}

export interface InsertedAgentMention {
  value: string
  cursor: number
}

function normalized(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .trim()
}

function mentionLabel(candidate: AgentMentionCandidate): string {
  return candidate.label.trim() || candidate.projectName.trim()
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Find the unfinished @mention immediately before the textarea caret. */
export function activeAgentMentionAtCursor(
  value: string,
  cursorPosition: number,
  candidates: AgentMentionCandidate[] = []
): ActiveAgentMention | null {
  const cursor = Math.max(0, Math.min(value.length, cursorPosition))
  const beforeCursor = value.slice(0, cursor)
  const start = beforeCursor.lastIndexOf('@')
  if (start < 0) return null
  const preceding = value[start - 1]
  if (start > 0 && !/[\s([{]/.test(preceding)) return null
  const query = value.slice(start + 1, cursor)
  if (query.length > 80 || /[\n\r@,;:!?()[\]{}]/.test(query)) return null
  const normalizedQuery = normalized(query)
  const followsCommittedMention = candidates.some((candidate) => {
    const label = normalized(mentionLabel(candidate))
    return label && normalizedQuery.startsWith(`${label} `)
  })
  if (followsCommittedMention) return null
  return { start, end: cursor, query }
}

export function filterAgentMentions<T extends AgentMentionCandidate>(
  candidates: T[],
  query: string
): T[] {
  const needle = normalized(query)
  return candidates
    .map((candidate, index) => {
      const label = normalized(mentionLabel(candidate))
      const project = normalized(candidate.projectName)
      const score = !needle
        ? 0
        : label.startsWith(needle)
          ? 0
          : project.startsWith(needle)
            ? 1
            : label.includes(needle)
              ? 2
              : project.includes(needle)
                ? 3
                : 10
      return { candidate, index, score }
    })
    .filter(({ score }) => score < 10)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ candidate }) => candidate)
}

export function insertAgentMention(
  value: string,
  mention: ActiveAgentMention,
  candidate: AgentMentionCandidate
): InsertedAgentMention {
  const token = `@${mentionLabel(candidate)}`
  const nextCharacter = value[mention.end]
  const suffix = !nextCharacter || !/\s/.test(nextCharacter) ? ' ' : ''
  const nextValue = `${value.slice(0, mention.start)}${token}${suffix}${value.slice(mention.end)}`
  return { value: nextValue, cursor: mention.start + token.length + suffix.length }
}

/** Resolve visible mention tokens to the durable participant ids sent to the collaboration API. */
export function mentionedAgentIds(value: string, candidates: AgentMentionCandidate[]): string[] {
  return candidates.flatMap((candidate) => {
    const label = mentionLabel(candidate)
    if (!label) return []
    const matcher = new RegExp(`(^|[\\s([{])@${regexEscape(label)}(?=$|[\\s,.;:!?\\)\\]}])`, 'iu')
    return matcher.test(value) ? [candidate.id] : []
  })
}

export function resolveGroupMessageRecipients(
  value: string,
  candidates: AgentMentionCandidate[],
  fallbackParticipantId?: string
): string[] {
  const mentioned = mentionedAgentIds(value, candidates)
  if (mentioned.length) return mentioned
  return fallbackParticipantId
    ? candidates.some(({ id }) => id === fallbackParticipantId)
      ? [fallbackParticipantId]
      : []
    : candidates.map(({ id }) => id)
}
