import type { Message } from '../types/chat.types'
import type { PromptRefinementHistoryItem } from '../../../shared/prompts/auxiliaryPrompts'

const DEFAULT_MAX_MESSAGES = 16
const DEFAULT_MAX_CHARACTERS = 14_000
const MAX_MESSAGE_CHARACTERS = 3_000

export interface PromptRefinementHistorySelection {
  recentHistory: PromptRefinementHistoryItem[]
  historyTruncated: boolean
}

function speakerForMessage(message: Message): string {
  if (message.role === 'user') return message.senderLabel?.trim() || 'You'
  return message.senderLabel?.trim() || message.peerLabel?.trim() || 'Assistant'
}

function textForMessage(message: Message): string {
  const direct = message.content.trim()
  if (direct) return direct
  return (
    message.segments
      ?.filter((segment) => segment.type === 'text' && segment.content?.trim())
      .map((segment) => segment.content?.trim())
      .filter((content): content is string => Boolean(content))
      .join('\n\n') || ''
  )
}

function truncateMessage(content: string, maxCharacters: number): string {
  if (content.length <= maxCharacters) return content
  if (maxCharacters < 20) return content.slice(0, maxCharacters)
  const marker = '\n…\n'
  const available = maxCharacters - marker.length
  const headLength = Math.ceil(available * 0.65)
  return `${content.slice(0, headLength).trimEnd()}${marker}${content.slice(-Math.max(0, available - headLength)).trimStart()}`
}

/**
 * Selects a small, human-readable conversation excerpt for prompt refinement.
 * Raw tool output, thinking, app notices, hidden records, and synthetic loading
 * messages stay out of the auxiliary request.
 */
export function selectPromptRefinementHistory(
  messages: readonly Message[],
  options: { maxMessages?: number; maxCharacters?: number } = {}
): PromptRefinementHistorySelection {
  const maxMessages = Math.max(1, options.maxMessages ?? DEFAULT_MAX_MESSAGES)
  const maxCharacters = Math.max(1, options.maxCharacters ?? DEFAULT_MAX_CHARACTERS)
  const candidates = messages.flatMap((message) => {
    if (message.hidden || message.role === 'system') return []
    const content = textForMessage(message)
    if (!content) return []
    return [
      {
        role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
        speaker: speakerForMessage(message),
        content
      }
    ]
  })

  const selected: PromptRefinementHistoryItem[] = []
  let usedCharacters = 0
  let historyTruncated = candidates.length > maxMessages

  for (let index = candidates.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const candidate = candidates[index]
    const remaining = maxCharacters - usedCharacters
    if (remaining <= 0) {
      historyTruncated = true
      break
    }
    const allowed = Math.min(MAX_MESSAGE_CHARACTERS, remaining)
    const content = truncateMessage(candidate.content, allowed).trim()
    if (!content) continue
    if (content.length < candidate.content.length) historyTruncated = true
    selected.push({ ...candidate, content })
    usedCharacters += content.length
  }

  if (selected.length < candidates.length) historyTruncated = true
  selected.reverse()
  return { recentHistory: selected, historyTruncated }
}
