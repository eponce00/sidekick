export const CONVERSATION_TITLE_VERSION = 4
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
  source?: 'generated' | 'fallback'
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

const CONVERSATION_TITLE_META_PREAMBLES = [
  /^(?:the\s+)?user\s+(?:(?:is|was)\s+)?(?:asking|requesting|trying|wants?|wanted|needs?|needed|would\s+like)(?:\s+me)?\s+(?:to\s+)?/iu,
  /^(?:the\s+)?user\s+(?:asks?|asked|requests?|requested)(?:\s+me)?\s+(?:to\s+)?/iu,
  /^(?:i\s+)(?:need|should|will|must|want|have|am\s+going)(?:\s+to)?\s+/iu,
  /^(?:this\s+)?(?:conversation|request|task)\s+(?:is\s+)?(?:about|asks?(?:\s+me)?\s+to|requests?(?:\s+me)?\s+to)\s+/iu,
  /^(?:el|la)\s+usuari[oa]\s+(?:(?:est[aá]|estaba)\s+)?(?:pidiendo|preguntando|quiere|quer[ií]a|necesita|solicita)(?:\s+que)?(?:\s+yo)?\s*/iu,
  /^(?:necesito|debo|voy\s+a|tengo\s+que)\s+/iu
]

/** Removes common model-narration prefixes while retaining the concrete topic. */
export function stripConversationTitleMetaPreamble(value: string): string {
  let normalized = value.trim()
  for (let pass = 0; pass < 3; pass += 1) {
    const previous = normalized
    for (const pattern of CONVERSATION_TITLE_META_PREAMBLES) {
      normalized = normalized.replace(pattern, '').trim()
    }
    if (normalized === previous) break
  }
  return normalized
}

/** Rejects outputs that describe the naming task instead of the conversation. */
export function isUsableGeneratedConversationTitle(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized || !/[\p{L}\p{N}]/u.test(normalized)) return false
  if (CONVERSATION_TITLE_META_PREAMBLES.some((pattern) => pattern.test(normalized))) return false
  if (
    /^(?:untitled(?:\s+conversation)?|conversation\s+title|user\s+(?:request|question)|(?:create|generate|write|make)\s+(?:a\s+)?(?:\d+\s*[-–]\s*\d+)?(?:\s+word)?(?:\s+(?:conversation\s+)?title)?$|(?:create|generate|write|make)\s+(?:a\s+)?(?:\d+\s*[-–]\s*\d+\s+word\s+)?(?:conversation\s+)?title\b)/iu.test(
      normalized
    )
  ) {
    return false
  }

  const meaningfulWords = normalized
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .filter((word) => !/^(?:a|an|the|to|of|for|el|la|los|las|de|para|un|una)$/iu.test(word))
  return (
    meaningfulWords.length >= 2 && !meaningfulWords.every((word) => /^\d+(?:-\d+)?$/u.test(word))
  )
}

export function createFallbackConversationTitle(content: string): string {
  const normalized = stripConversationTitleMetaPreamble(
    content
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/^[#>*\-\s]+/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
  if (!normalized) return 'Untitled conversation'

  const words = normalized.split(' ').slice(0, 7)
  const weakTrailingWord = /^(?:a|an|the|to|of|for|and|or|but|with|from|in|on|at|by|as|we|i|you|it|this|that|is|are|am|be|el|la|los|las|un|una|de|del|para|por|y|o|pero|con|en|yo|t[uú]|usted|nosotros|esto|esta|que)$/iu
  while (words.length > 2) {
    const lastWord = words.at(-1)?.replace(/[^\p{L}\p{N}]+/gu, '') ?? ''
    if (!weakTrailingWord.test(lastWord)) break
    words.pop()
  }
  const title = words
    .join(' ')
    .slice(0, 64)
    .replace(/[\s,.;:!?\-–—]+$/u, '')
  return title.replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase()) || 'Untitled conversation'
}
