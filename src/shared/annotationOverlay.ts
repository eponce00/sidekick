import type { BrowserAnnotationBox } from './messageContextAttachments'
import { MAX_BROWSER_ANNOTATION_NOTE_CHARACTERS } from './messageContextAttachments'

/** What the style editor can change on a marked element, live on the page. */
export const ANNOTATION_STYLE_PROPERTIES = [
  'font-size',
  'font-family',
  'font-weight',
  'color',
  'background-color',
  'opacity'
] as const

export type AnnotationStyleProperty = (typeof ANNOTATION_STYLE_PROPERTIES)[number]
export type AnnotationStyleValues = Partial<Record<AnnotationStyleProperty, string>>

const MAX_STYLE_VALUE_CHARACTERS = 120

/**
 * A style value as plain CSS words, numbers and colors, or null. Nothing that could end the
 * declaration, start another, or load anything from elsewhere.
 */
export function annotationStyleValue(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_STYLE_VALUE_CHARACTERS) return null
  const trimmed = value.trim()
  if (!/^[\w\s#.,%()'"+-]*$/.test(trimmed) || /url\s*\(|image-set|expression/i.test(trimmed))
    return null
  return trimmed
}

/** Only the properties the editor offers, each with a plain value; null when none are. */
export function annotationStyleValues(raw: unknown): AnnotationStyleValues | null {
  if (!raw || typeof raw !== 'object') return null
  const values: AnnotationStyleValues = {}
  for (const property of ANNOTATION_STYLE_PROPERTIES) {
    const value = (raw as Record<string, unknown>)[property]
    if (value === undefined) continue
    const clean = annotationStyleValue(value)
    if (clean === null) return null
    values[property] = clean
  }
  return values
}

/**
 * The surface marks are made on: SideKick's own page in a view over the live page while the user
 * annotates. The live page cannot see it, draw above it, or read it. The main process tells it what
 * to draw; it tells the main process what the user did, and every message is checked.
 */
export interface AnnotationOverlayState {
  /** The app's accent and the text it carries, each checked to be a plain color. */
  accent: string
  accentText: string
  theme: 'dark' | 'light'
  marks: Array<
    BrowserAnnotationBox & { id: string; number: number; area: boolean; name: string; note: string }
  >
  hover?: BrowserAnnotationBox & { label: string }
  drag?: BrowserAnnotationBox
  /** The mark whose note is open. */
  editing?: string
  markersHidden: boolean
  /** The style editor's mark and the element's styles as it opened, from the page. */
  style?: { id: string; values: AnnotationStyleValues }
  /** The app can take dictation for a note. */
  canDictate: boolean
  /** Dictation into the open note; `heard` is the latest text, numbered so each is used once. */
  dictation?: { listening: boolean; heard?: { seq: number; text: string; final: boolean } }
}

export type AnnotationOverlayMessage =
  | { type: 'pointer'; kind: 'move' | 'down' | 'up' | 'leave'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'note'; id: string; note: string }
  | { type: 'edit'; id: string | null }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'markers'; hidden: boolean }
  | { type: 'send' }
  | { type: 'stop' }
  | { type: 'screenshot' }
  | { type: 'styleOpen'; id: string }
  | { type: 'style'; id: string; styles: AnnotationStyleValues }
  /** Closes the editor, keeping the changes on the page or putting the element back. */
  | { type: 'styleDone'; id: string; keep: boolean }
  | { type: 'dictate'; on: boolean }

const finite = (value: unknown, limit = 100_000): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit

const markId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 100

/** A message from the overlay, or null for anything that is not one. */
export function parseAnnotationOverlayMessage(raw: unknown): AnnotationOverlayMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const message = raw as Record<string, unknown>
  switch (message.type) {
    case 'pointer':
      return ['move', 'down', 'up', 'leave'].includes(message.kind as string) &&
        finite(message.x) &&
        finite(message.y)
        ? {
            type: 'pointer',
            kind: message.kind as 'move' | 'down' | 'up' | 'leave',
            x: message.x,
            y: message.y
          }
        : null
    case 'wheel':
      return finite(message.x) &&
        finite(message.y) &&
        finite(message.deltaX, 10_000) &&
        finite(message.deltaY, 10_000)
        ? {
            type: 'wheel',
            x: message.x,
            y: message.y,
            deltaX: message.deltaX,
            deltaY: message.deltaY
          }
        : null
    case 'note':
      return markId(message.id) &&
        typeof message.note === 'string' &&
        message.note.length <= MAX_BROWSER_ANNOTATION_NOTE_CHARACTERS
        ? { type: 'note', id: message.id, note: message.note }
        : null
    case 'edit':
      return message.id === null || markId(message.id) ? { type: 'edit', id: message.id } : null
    case 'remove':
      return markId(message.id) ? { type: 'remove', id: message.id } : null
    case 'markers':
      return typeof message.hidden === 'boolean'
        ? { type: 'markers', hidden: message.hidden }
        : null
    case 'styleOpen':
      return markId(message.id) ? { type: 'styleOpen', id: message.id } : null
    case 'style': {
      const styles = annotationStyleValues(message.styles)
      return markId(message.id) && styles ? { type: 'style', id: message.id, styles } : null
    }
    case 'styleDone':
      return markId(message.id) && typeof message.keep === 'boolean'
        ? { type: 'styleDone', id: message.id, keep: message.keep }
        : null
    case 'dictate':
      return typeof message.on === 'boolean' ? { type: 'dictate', on: message.on } : null
    case 'clear':
    case 'send':
    case 'stop':
    case 'screenshot':
      return { type: message.type }
    default:
      return null
  }
}
