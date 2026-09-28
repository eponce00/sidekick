import { parseMessageImages, type MessageImageAttachment } from '../../../shared/messageImages'
import {
  parseMessageContextAttachments,
  type MessageContextAttachment
} from '../../../shared/messageContextAttachments'

/**
 * What the user had typed or attached in a chat but not sent. A chat's panel
 * is unmounted when the user switches away, so the draft lives in this
 * machine's storage, one key per conversation, and survives a restart.
 */
export interface ComposerDraft {
  text: string
  images: MessageImageAttachment[]
  attachments: MessageContextAttachment[]
}

/**
 * A chat that has not been sent yet has no id. Every new chat shares this one
 * slot, so a message started there is still waiting the next time a new chat
 * is opened, and it is cleared once that chat's first message is sent.
 */
export const NEW_CHAT_DRAFT_KEY = 'new'

const KEY_PREFIX = 'sidekick.composerDraft.'
export const MAX_COMPOSER_DRAFTS = 40
export const MAX_COMPOSER_DRAFT_TEXT = 100_000
/** Images are data URLs, so they are the first thing given up to stay within storage limits. */
export const MAX_COMPOSER_DRAFT_CHARACTERS = 1_500_000

const EMPTY_DRAFT: ComposerDraft = { text: '', images: [], attachments: [] }

interface StoredComposerDraft extends ComposerDraft {
  updatedAt: number
}

function storageKey(key: string): string {
  return `${KEY_PREFIX}${key}`
}

export function isEmptyComposerDraft(draft: ComposerDraft): boolean {
  return !draft.text.trim() && !draft.images.length && !draft.attachments.length
}

export function loadComposerDraft(key: string): ComposerDraft {
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (!raw) return EMPTY_DRAFT
    const stored = JSON.parse(raw) as Partial<StoredComposerDraft>
    return {
      text: typeof stored.text === 'string' ? stored.text.slice(0, MAX_COMPOSER_DRAFT_TEXT) : '',
      images: parseMessageImages(JSON.stringify(stored.images ?? [])),
      attachments: parseMessageContextAttachments(JSON.stringify(stored.attachments ?? []))
    }
  } catch {
    return EMPTY_DRAFT
  }
}

export function deleteComposerDraft(key: string): void {
  try {
    localStorage.removeItem(storageKey(key))
  } catch {
    // Storage can be unavailable; there is then nothing to delete.
  }
}

function storedDraftKeys(): { key: string; updatedAt: number }[] {
  const drafts: { key: string; updatedAt: number }[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key?.startsWith(KEY_PREFIX)) continue
    let updatedAt = 0
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<StoredComposerDraft>
      updatedAt = typeof stored.updatedAt === 'number' ? stored.updatedAt : 0
    } catch {
      // An unreadable draft is the first to go.
    }
    drafts.push({ key: key.slice(KEY_PREFIX.length), updatedAt })
  }
  return drafts
}

/** Keeps the newest drafts, always including `keep`. */
function evictOldDrafts(keep: string, limit = MAX_COMPOSER_DRAFTS): void {
  const drafts = storedDraftKeys()
    .filter((draft) => draft.key !== keep)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  for (const draft of drafts.slice(Math.max(0, limit - 1))) deleteComposerDraft(draft.key)
}

/** The draft trimmed to fit: images go first, then attachments, and the text is capped. */
function boundedDraft(draft: ComposerDraft): StoredComposerDraft {
  const bounded: StoredComposerDraft = {
    text: draft.text.slice(0, MAX_COMPOSER_DRAFT_TEXT),
    images: draft.images,
    attachments: draft.attachments,
    updatedAt: Date.now()
  }
  if (JSON.stringify(bounded).length > MAX_COMPOSER_DRAFT_CHARACTERS) bounded.images = []
  if (JSON.stringify(bounded).length > MAX_COMPOSER_DRAFT_CHARACTERS) bounded.attachments = []
  return bounded
}

export function saveComposerDraft(key: string, draft: ComposerDraft): void {
  if (isEmptyComposerDraft(draft)) {
    deleteComposerDraft(key)
    return
  }
  const bounded = boundedDraft(draft)
  try {
    const isNew = localStorage.getItem(storageKey(key)) === null
    localStorage.setItem(storageKey(key), JSON.stringify(bounded))
    if (isNew) evictOldDrafts(key)
  } catch {
    // Full storage: make room from older drafts, then keep at least the text.
    try {
      evictOldDrafts(key, Math.ceil(MAX_COMPOSER_DRAFTS / 2))
      localStorage.setItem(
        storageKey(key),
        JSON.stringify({ ...bounded, images: [], attachments: [] })
      )
    } catch {
      // Storage is unavailable. The draft still lives while the chat is open.
    }
  }
}
