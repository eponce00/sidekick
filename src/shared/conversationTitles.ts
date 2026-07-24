export const CONVERSATION_TITLE_VERSION = 1
export const CONVERSATION_TITLE_BACKFILL_RETRY_MS = 6 * 60 * 60 * 1000

export const CONVERSATION_TITLE_SOURCES = [
  'legacy',
  'placeholder',
  'fallback',
  'generated',
  'user',
  'fork',
  'preserved'
] as const

export type ConversationTitleSource = (typeof CONVERSATION_TITLE_SOURCES)[number]

export interface ConversationTitleUpdateOptions {
  source?: ConversationTitleSource
  preserveUpdatedAt?: boolean
}

export interface ConversationTitleBackfillCandidate {
  id: string
  title: string
  titleSource: ConversationTitleSource
  titleVersion: number
  firstUserMessage: string
  firstAssistantMessage: string | null
}

export interface ConversationTitleBackfillIdentity {
  id: string
  expectedTitle: string
}

export interface CompleteConversationTitleBackfillInput extends ConversationTitleBackfillIdentity {
  title: string
}

export interface FailConversationTitleBackfillInput extends ConversationTitleBackfillIdentity {
  error: string
}

export function isConversationTitleSource(value: unknown): value is ConversationTitleSource {
  return (
    typeof value === 'string' && (CONVERSATION_TITLE_SOURCES as readonly string[]).includes(value)
  )
}

export function conversationTitleVersionForSource(source: ConversationTitleSource): number {
  return source === 'generated' || source === 'user' || source === 'fork' || source === 'preserved'
    ? CONVERSATION_TITLE_VERSION
    : 0
}

export function createFallbackConversationTitle(content: string): string {
  const normalized = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^[#>*\-\s]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return 'Untitled conversation'

  const words = normalized.split(' ').slice(0, 7)
  const title = words
    .join(' ')
    .slice(0, 64)
    .replace(/[\s,.;:!?\-–—]+$/u, '')
  return title.replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase()) || 'Untitled conversation'
}
