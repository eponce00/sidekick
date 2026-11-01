import type { CompanionChat } from '../../../shared/companion'
import { createWelcomeSuggestions } from '../utils/welcomeSuggestions'

export type HomeSuggestion =
  | { kind: 'open'; label: string; chat: CompanionChat }
  | { kind: 'prompt'; label: string; prompt: string }

const GENERIC_TITLES = new Set(['', 'new chat', 'new conversation', 'untitled chat'])

function compactTitle(title: string): string {
  const normalized = title.replace(/\s+/g, ' ').trim()
  return normalized.length <= 30 ? normalized : `${normalized.slice(0, 29).trimEnd()}…`
}

/**
 * The new-chat home's two suggestions, from what the phone already has, as the desktop's empty
 * chat makes them: the chat worked on most recently, to open again, and one of the desktop's own
 * starters for the message box. Nothing is sent to a model to make them.
 */
export function homeSuggestions(chats: readonly CompanionChat[] | null): HomeSuggestion[] {
  const [first, second] = createWelcomeSuggestions({ recentConversationTitles: [] })
  const latest = [...(chats ?? [])]
    .filter((chat) => !GENERIC_TITLES.has(chat.title.trim().toLocaleLowerCase()))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]
  const starters: HomeSuggestion[] = [first, second].map((starter) => ({
    kind: 'prompt',
    label: starter.label,
    prompt: starter.prompt
  }))
  if (!latest) return starters
  return [
    { kind: 'open', label: `Continue “${compactTitle(latest.title)}”`, chat: latest },
    starters[0]
  ]
}
