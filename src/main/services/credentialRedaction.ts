/**
 * Keeps stored credential values out of everything SideKick shows, stores, or sends to a model.
 *
 * Every stored value is matched together with the encodings a program is likely to print it in,
 * following the set the GitHub Actions runner registers for each secret. Redaction is the second
 * line behind a credential's scope: a process that holds a value can always transform it beyond
 * recognition, so this catches accidents and ordinary output, not a determined program.
 */
import { MIN_CREDENTIAL_VALUE } from '../../shared/credentials'

export interface RedactableSecret {
  alias: string
  value: string
}

/** Encoded forms shorter than this are too likely to occur by chance. */
const MIN_VARIANT_LENGTH = 6
/** A held-back tail is released after this long without more output, so prompts still show. */
export const REDACTION_STREAM_QUIET_MS = 300

/**
 * Terminal control sequences a program can print inside a value, splitting it for anything that
 * reads the raw text: CSI (colors, cursor moves), OSC (titles, links), and short escapes such as
 * `ESC 7` or `ESC ( B`.
 */
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]*[0-~])/g
/** An escape a chunk ends in the middle of, which the next chunk completes. */
// eslint-disable-next-line no-control-regex
const PARTIAL_ANSI = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?|[ -/]*)$/
/** How the redactor writes a value in place; a write that adds one would corrupt a file. */
const PLACEHOLDER = /\[secret: ([a-z0-9][a-z0-9_~-]{0,80})\]/g

function escapeHtml(value: string, apostrophe: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, apostrophe)
}

/** `text` with each character `characters` matches written as a JSON `\u` escape. */
function unicodeEscaped(text: string, characters: RegExp, upperCase: boolean): string {
  return text.replace(characters, (character) => {
    const hex = character.charCodeAt(0).toString(16).padStart(4, '0')
    return `\\u${upperCase ? hex.toUpperCase() : hex}`
  })
}

/**
 * The parts of a value's Base64 that do not depend on the bytes around it, at each of the three
 * alignments it can have inside a longer encoded string, plus its own padded encoding.
 */
function base64Forms(bytes: Buffer): string[] {
  const forms = [bytes.toString('base64')]
  for (let shift = 0; shift < 3; shift++) {
    const data = Buffer.concat([Buffer.alloc(shift), bytes])
    const encoded = data.toString('base64').replace(/=+$/, '')
    // Characters that carry bits of the bytes before or after the value change with them.
    const lead = [0, 2, 3][shift]
    const trail = data.length % 3 === 0 ? 0 : 1
    forms.push(encoded.slice(lead, encoded.length - trail))
  }
  return forms.flatMap((form) => [form, form.replace(/\+/g, '-').replace(/\//g, '_')])
}

/** Every form of `value` the redactor looks for. */
export function secretVariants(value: string): string[] {
  if (value.length < MIN_CREDENTIAL_VALUE) return []
  const encoded: string[] = []
  const lines = value.split(/\r?\n/)
  // Each line on its own, since output arrives line by line; PEM armor lines are not secret.
  if (lines.length > 1) {
    encoded.push(...lines.filter((line) => !/^-----(BEGIN|END) [A-Z0-9 ]+-----$/.test(line.trim())))
  }
  const json = JSON.stringify(value).slice(1, -1)
  const slashes = json.replace(/\//g, '\\/')
  // JSON as other writers produce it: `<`, `>` and `&` as \u escapes (Go), `<` alone (the
  // page-content blocks SideKick gives its model), every non-ASCII character escaped (Python's
  // default), `/` escaped as well (PHP's default), and JSON text quoted again inside another
  // JSON string.
  encoded.push(
    slashes,
    unicodeEscaped(slashes, /[\u0080-￿]/g, false),
    json,
    unicodeEscaped(json, /</g, false),
    unicodeEscaped(json, /[<>&]/g, false),
    unicodeEscaped(json, /[<>&]/g, true),
    unicodeEscaped(json, /[\u0080-\uffff]/g, false),
    unicodeEscaped(json, /[<>&\u0080-\uffff]/g, false),
    JSON.stringify(json).slice(1, -1)
  )
  try {
    const component = encodeURIComponent(value)
    encoded.push(
      component,
      component.replace(/%20/g, '+'),
      component.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
      encodeURI(value),
      // Form and query fields as URLSearchParams writes them, which also escapes `!'()~`.
      new URLSearchParams({ v: value }).toString().slice(2)
    )
  } catch {
    // A lone surrogate cannot be percent-encoded, so no program prints it that way either.
  }
  encoded.push(escapeHtml(value, '&#39;'), escapeHtml(value, '&apos;'), escapeHtml(value, '&#x27;'))
  // Bash and PowerShell quoting, single and double.
  encoded.push(
    value.replace(/'/g, `'\\''`),
    value.replace(/[\\"$`]/g, '\\$&'),
    value.replace(/'/g, "''"),
    value.replace(/[`"$]/g, '`$&')
  )
  const utf8 = Buffer.from(value, 'utf8')
  encoded.push(...base64Forms(utf8), ...base64Forms(Buffer.from(value, 'utf16le')))
  const hex = utf8.toString('hex')
  encoded.push(hex, hex.toUpperCase())
  return [
    ...new Set([value, ...encoded.filter((form) => form.length >= MIN_VARIANT_LENGTH)])
  ].filter(Boolean)
}

interface AutomatonNode {
  next: Map<number, number>
  fail: number
  depth: number
  /** The longest pattern that ends here, as an index into `patterns`, or -1. */
  match: number
}

interface Pattern {
  length: number
  alias: string
}

interface Span {
  start: number
  end: number
  alias: string
}

/** Aho–Corasick over UTF-16 code units: one pass finds every stored form in a text. */
class Automaton {
  private readonly nodes: AutomatonNode[] = [{ next: new Map(), fail: 0, depth: 0, match: -1 }]
  private readonly patterns: Pattern[] = []

  constructor(entries: ReadonlyArray<{ text: string; alias: string }>) {
    for (const { text, alias } of entries) this.add(text, alias)
    this.link()
  }

  get empty(): boolean {
    return this.patterns.length === 0
  }

  private add(text: string, alias: string): void {
    let state = 0
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index)
      let next = this.nodes[state].next.get(code)
      if (next === undefined) {
        next = this.nodes.length
        this.nodes.push({
          next: new Map(),
          fail: 0,
          depth: this.nodes[state].depth + 1,
          match: -1
        })
        this.nodes[state].next.set(code, next)
      }
      state = next
    }
    if (this.nodes[state].match === -1) {
      this.nodes[state].match = this.patterns.length
      this.patterns.push({ length: text.length, alias })
      this.longest = Math.max(this.longest, text.length)
    }
  }

  private link(): void {
    const queue: number[] = []
    for (const child of this.nodes[0].next.values()) queue.push(child)
    for (let head = 0; head < queue.length; head++) {
      const state = queue[head]
      const node = this.nodes[state]
      for (const [code, child] of node.next) {
        let fail = node.fail
        while (fail !== 0 && !this.nodes[fail].next.has(code)) fail = this.nodes[fail].fail
        const target = this.nodes[fail].next.get(code)
        this.nodes[child].fail = target !== undefined && target !== child ? target : 0
        queue.push(child)
      }
      // A node's own pattern is the longest one ending here; otherwise inherit its suffix's.
      if (node.match === -1) node.match = this.nodes[node.fail].match
    }
  }

  /** The longest form it looks for, in UTF-16 code units. */
  longest = 0

  /** Matches merged where they overlap, and how much of the text's end could still begin one. */
  scan(text: string): { spans: Span[]; tail: number } {
    const spans: Span[] = []
    let state = 0
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index)
      while (state !== 0 && !this.nodes[state].next.has(code)) state = this.nodes[state].fail
      state = this.nodes[state].next.get(code) ?? 0
      const match = this.nodes[state].match
      if (match === -1) continue
      const pattern = this.patterns[match]
      const span = { start: index + 1 - pattern.length, end: index + 1, alias: pattern.alias }
      // Overlapping matches become one redaction, labelled by the one that starts first.
      while (spans.length && span.start < spans[spans.length - 1].end) {
        const previous = spans.pop()!
        if (previous.start <= span.start) {
          span.start = previous.start
          span.alias = previous.alias
        }
      }
      spans.push(span)
    }
    return { spans, tail: this.nodes[state].depth }
  }
}

function applySpans(text: string, spans: readonly Span[]): string {
  if (!spans.length) return text
  let result = ''
  let cursor = 0
  for (const span of spans) {
    result += text.slice(cursor, span.start) + `[secret: ${span.alias}]`
    cursor = span.end
  }
  return result + text.slice(cursor)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

const BASE64_LINE = /^[\w+/-]+$/
const BASE64_CHARACTER = /[\w+/=-]/

/**
 * Line breaks inside Base64 wrapped at the widths encoders use: 76 columns (MIME, `base64`) and
 * 64 (PEM, OpenSSL). A break at the very end counts, so a stream holds a line the next continues.
 */
function wrappedBase64Breaks(raw: string): Array<[number, number]> {
  const breaks: Array<[number, number]> = []
  let lineStart = 0
  for (let index = raw.indexOf('\n'); index !== -1; index = raw.indexOf('\n', lineStart)) {
    const lineEnd = index > lineStart && raw[index - 1] === '\r' ? index - 1 : index
    const width = lineEnd - lineStart
    if (
      (width === 64 || width === 76) &&
      (index + 1 === raw.length || BASE64_CHARACTER.test(raw[index + 1])) &&
      BASE64_LINE.test(raw.slice(lineStart, lineEnd))
    ) {
      breaks.push([lineEnd, index + 1])
    }
    lineStart = index + 1
  }
  return breaks
}

/**
 * Text as values are matched in it, without escapes and with wrapped Base64 joined into one
 * line, and where each of its characters sits in the original.
 */
function matchableText(raw: string): { text: string; at: number[] } | null {
  const cuts: Array<[number, number]> = raw.includes('\n') ? wrappedBase64Breaks(raw) : []
  if (raw.includes('\x1b')) {
    for (const match of raw.matchAll(ANSI_SEQUENCE)) {
      cuts.push([match.index, match.index + match[0].length])
    }
  }
  if (!cuts.length) return null
  cuts.sort((left, right) => left[0] - right[0])
  let text = ''
  const at: number[] = []
  let cursor = 0
  const keep = (end: number): void => {
    for (let index = cursor; index < end; index++) at.push(index)
    text += raw.slice(cursor, end)
  }
  for (const [start, end] of cuts) {
    if (start < cursor) continue
    keep(start)
    cursor = end
  }
  keep(raw.length)
  at.push(raw.length)
  return { text, at }
}

/** Redacts a stream delivered in chunks, so a value split between two chunks is still caught. */
export class CredentialRedactionStream {
  private held = ''

  constructor(private readonly redactor: CredentialRedactor) {}

  /** Whether part of the output is held back because it could begin a stored value. */
  get holding(): boolean {
    return this.held.length > 0
  }

  push(chunk: string): string {
    const text = this.held + chunk
    const { spans, holdFrom } = this.redactor.scan(text)
    let boundary = holdFrom
    // A complete match that reaches into the held tail waits with it, whole.
    const crossing = spans.find((span) => span.start < boundary && span.end > boundary)
    if (crossing) boundary = crossing.start
    if (boundary > 0 && boundary < text.length && isHighSurrogate(text.charCodeAt(boundary - 1))) {
      boundary--
    }
    this.held = text.slice(boundary)
    return applySpans(
      text.slice(0, boundary),
      spans.filter((span) => span.end <= boundary)
    )
  }

  /** Releases whatever is held, redacted as it stands. */
  flush(): string {
    const text = this.held
    this.held = ''
    return this.redactor.redact(text)
  }
}

export class CredentialRedactor {
  private automaton = new Automaton([])
  private aliases = new Set<string>()

  /** Replaces the values to look for; aliases label each redaction. */
  setSecrets(secrets: readonly RedactableSecret[]): void {
    const entries = secrets.flatMap(({ alias, value }) => {
      const forms = new Set(secretVariants(value))
      // A value stored with spaces around it is still hidden when printed without them.
      if (value.trim() !== value) for (const form of secretVariants(value.trim())) forms.add(form)
      return [...forms].map((text) => ({ text, alias }))
    })
    // Longer forms first, so a form contained in another is reported under the longer match.
    entries.sort((left, right) => right.text.length - left.text.length)
    this.automaton = new Automaton(entries)
    this.aliases = new Set(entries.map((entry) => entry.alias))
  }

  get active(): boolean {
    return !this.automaton.empty
  }

  /**
   * Every match in `text`, also where escapes or Base64 line wrapping split a value, and where a
   * tail that could still
   * begin one starts, including an escape cut off at the end.
   */
  scan(text: string): { spans: Span[]; holdFrom: number } {
    if (this.automaton.empty || !text) return { spans: [], holdFrom: text.length }
    // An escape cut off at the end is left out of matching, and held with whatever it follows.
    const partial = text.includes('\x1b') ? PARTIAL_ANSI.exec(text) : null
    const complete = partial ? text.slice(0, partial.index) : text
    const plain = matchableText(complete)
    if (!plain) {
      const { spans, tail } = this.automaton.scan(complete)
      return { spans, holdFrom: complete.length - tail }
    }
    const { spans, tail } = this.automaton.scan(plain.text)
    return {
      spans: spans.map((span) => ({
        start: plain.at[span.start],
        end: plain.at[span.end - 1] + 1,
        alias: span.alias
      })),
      holdFrom: tail ? plain.at[plain.text.length - tail] : complete.length
    }
  }

  redact(text: string): string {
    if (this.automaton.empty || !text) return text
    return applySpans(text, this.scan(text).spans)
  }

  /**
   * How many characters of context a window of text needs on each side, so a value that crosses
   * the window's edge is still recognised.
   */
  get context(): number {
    return this.automaton.longest
  }

  /** Redacts `text.slice(from, to)`, matching against the whole of `text` around it. */
  redactWindow(text: string, from: number, to: number): string {
    if (this.automaton.empty) return text.slice(from, to)
    let result = ''
    let cursor = from
    for (const span of this.scan(text).spans) {
      if (span.end <= from || span.start >= to) continue
      result += text.slice(cursor, Math.max(cursor, span.start)) + `[secret: ${span.alias}]`
      cursor = span.end
    }
    return cursor < to ? result + text.slice(cursor, to) : result
  }

  /** How many placeholders for a value it hides `text` holds. */
  placeholders(text: string): number {
    let count = 0
    for (const match of text.matchAll(PLACEHOLDER)) if (this.aliases.has(match[1])) count++
    return count
  }

  /**
   * Redacts every string, and every key, inside plain objects and arrays, returning the same
   * object when nothing matched. Only the `source` of each top-level `media` item, which holds
   * image data, is left alone; its name and description are redacted like the rest.
   */
  redactDeep<T>(value: T): T {
    if (this.automaton.empty) return value
    return this.walk(value, 0, false) as T
  }

  private walk(value: unknown, depth: number, mediaItem: boolean): unknown {
    if (typeof value === 'string') return this.redact(value)
    if (!value || typeof value !== 'object' || depth > 64) return value
    if (Array.isArray(value)) {
      let changed = false
      const items = value.map((item) => {
        const next = this.walk(item, depth + 1, mediaItem)
        changed ||= next !== item
        return next
      })
      return changed ? items : value
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return value
    let changed = false
    const entries = Object.entries(value).map(([key, item]) => {
      if (mediaItem && key === 'source') return [key, item]
      const nextKey = this.redact(key)
      const next = this.walk(item, depth + 1, depth === 0 && key === 'media')
      changed ||= next !== item || nextKey !== key
      return [nextKey, next]
    })
    return changed ? Object.fromEntries(entries) : value
  }

  stream(): CredentialRedactionStream {
    return new CredentialRedactionStream(this)
  }
}

/** The one redactor the main process uses; the credential vault keeps its values current. */
export const credentialRedactor = new CredentialRedactor()
