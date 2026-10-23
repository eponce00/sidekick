import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { ToolOutputReference } from '../../shared/agentRuntime'
import { estimateTextTokens } from '../../shared/contextBudget'
import { credentialRedactor, type CredentialRedactor } from './credentialRedaction'

export interface ToolOutputPolicy {
  maxBytes?: number
  maxLines?: number
  maxTokens?: number
  preview?: 'head' | 'tail' | 'head-tail'
  retentionMs?: number
}

export interface BoundedToolOutput {
  content: string
  output: ToolOutputReference
}

export interface ReadToolOutputResult {
  content: string
  offset: number
  nextOffset: number | null
  totalBytes: number
}

export interface ToolOutputMatch {
  /** UTF-8 byte offset of the match, for reading on from there. */
  offset: number
  /** The match with the text around it. */
  text: string
}

export interface SearchToolOutputResult {
  /** The first matches, in order. */
  matches: ToolOutputMatch[]
  /** Every match, counted up to MAX_COUNTED_MATCHES. */
  totalMatches: number
  totalBytes: number
}

/** One labelled part of a sectioned result, such as a command's stdout or stderr. */
export interface ToolOutputSection {
  name: string
  text: string
}

/** What the model was shown of one section. */
export interface BoundedToolOutputSection {
  name: string
  truncated: boolean
  /** UTF-8 byte offset, in the stored output, where the part left out starts. */
  omittedOffset?: number
  omittedBytes?: number
  omittedLines?: number
}

const DEFAULT_MAX_BYTES = 50 * 1024
const DEFAULT_MAX_LINES = 2_000
/** The most of one tool result the model sees before the rest is kept behind a handle. */
export const DEFAULT_TOOL_OUTPUT_TOKENS = 8_192
const DEFAULT_MAX_TOKENS = DEFAULT_TOOL_OUTPUT_TOKENS
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const HANDLE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** Room kept under the limits for the note that says what was left out and where to read it. */
const NOTE_RESERVE = { lines: 2, bytes: 512, tokens: 128 }
export const MAX_SEARCH_MATCHES = 20
const MAX_COUNTED_MATCHES = 10_000
/** Characters shown on each side of a match. */
const MATCH_CONTEXT = 120

interface CutLimits {
  maxLines: number
  maxBytes: number
  maxTokens: number
}

/**
 * Where a result too long to show is cut. The head and the tail are kept verbatim and end on
 * whole lines where the text has lines, so the model never reads a line that is cut in the
 * middle, unless a line is too long to show whole at all: then the room left shows the part of it
 * nearest the head or tail. Everything between them is one contiguous range of the original,
 * starting at `omittedOffset`, which `tool_output` reads back.
 */
export interface ToolOutputCut {
  truncated: boolean
  head: string
  tail: string
  originalBytes: number
  omittedOffset: number
  omittedBytes: number
  /** Line breaks in the part left out; zero when the cut falls inside one long line. */
  omittedLines: number
}

function resolveLimits(policy: ToolOutputPolicy): CutLimits {
  return {
    maxBytes: Math.max(1_024, policy.maxBytes ?? DEFAULT_MAX_BYTES),
    maxLines: Math.max(1, policy.maxLines ?? DEFAULT_MAX_LINES),
    maxTokens: Math.max(256, policy.maxTokens ?? DEFAULT_MAX_TOKENS)
  }
}

/** Splits text into lines that keep their own line break, so joining them gives it back. */
function linesOf(content: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let index = content.indexOf('\n'); index >= 0; index = content.indexOf('\n', start)) {
    lines.push(content.slice(start, index + 1))
    start = index + 1
  }
  if (start < content.length) lines.push(content.slice(start))
  return lines
}

function fits(text: string, limits: CutLimits): boolean {
  return (
    Buffer.byteLength(text, 'utf8') <= limits.maxBytes &&
    estimateTextTokens(text) <= limits.maxTokens
  )
}

/** Whole lines from one end that fit the limits; the token estimate of a line is summed. */
function wholeLines(
  lines: readonly string[],
  limits: CutLimits,
  fromEnd: boolean
): { count: number; text: string } {
  let bytes = 0
  let tokens = 0
  let count = 0
  while (count < lines.length && count < limits.maxLines) {
    const line = lines[fromEnd ? lines.length - 1 - count : count]
    const lineBytes = Buffer.byteLength(line, 'utf8')
    const lineTokens = estimateTextTokens(line)
    if (bytes + lineBytes > limits.maxBytes || tokens + lineTokens > limits.maxTokens) break
    bytes += lineBytes
    tokens += lineTokens
    count++
  }
  const kept = fromEnd ? lines.slice(lines.length - count) : lines.slice(0, count)
  return { count, text: kept.join('') }
}

/** The longest piece of one line, from its start or its end, that fits the limits. */
function partOfLine(line: string, limits: CutLimits, fromEnd: boolean): string {
  let low = 0
  let high = line.length
  let best = ''
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    let candidate = fromEnd ? line.slice(line.length - middle) : line.slice(0, middle)
    // Never split a surrogate pair.
    if (!fromEnd && /[\ud800-\udbff]$/.test(candidate)) candidate = candidate.slice(0, -1)
    if (fromEnd && /^[\udc00-\udfff]/.test(candidate)) candidate = candidate.slice(1)
    if (fits(candidate, limits)) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

function scaled(limits: CutLimits, share: number): CutLimits {
  return {
    maxLines: Math.floor(limits.maxLines * share),
    maxBytes: Math.floor(limits.maxBytes * share),
    maxTokens: Math.floor(limits.maxTokens * share)
  }
}

/** What is left of `limits` once `used` text of `lines` lines is kept. */
function remaining(limits: CutLimits, used: string, lines: number): CutLimits {
  return {
    maxLines: Math.max(0, limits.maxLines - lines),
    maxBytes: Math.max(0, limits.maxBytes - Buffer.byteLength(used, 'utf8')),
    maxTokens: Math.max(0, limits.maxTokens - estimateTextTokens(used))
  }
}

function cutWithin(
  content: string,
  limits: CutLimits,
  preview: NonNullable<ToolOutputPolicy['preview']>
): ToolOutputCut {
  const originalBytes = Buffer.byteLength(content, 'utf8')
  const lines = linesOf(content)
  if (lines.length <= limits.maxLines && fits(content, limits)) {
    return {
      truncated: false,
      head: content,
      tail: '',
      originalBytes,
      omittedOffset: originalBytes,
      omittedBytes: 0,
      omittedLines: 0
    }
  }
  const room: CutLimits = {
    maxLines: Math.max(0, limits.maxLines - NOTE_RESERVE.lines),
    maxBytes: Math.max(0, limits.maxBytes - NOTE_RESERVE.bytes),
    maxTokens: Math.max(0, limits.maxTokens - NOTE_RESERVE.tokens)
  }
  const headShare = preview === 'head' ? 1 : preview === 'tail' ? 0 : 0.5
  const headRoom = scaled(room, headShare)
  const tailRoom = scaled(room, 1 - headShare)
  const headLines = headShare > 0 ? wholeLines(lines, headRoom, false) : { count: 0, text: '' }
  let head = headLines.text
  // The next line is too long to show whole in any room this cut has, as a page's JSON on one
  // line is: what is left of the room shows its start rather than nothing of it.
  const longHeadLine =
    headShare > 0 && headLines.count < headRoom.maxLines ? lines[headLines.count] : undefined
  let headPart = ''
  if (longHeadLine !== undefined && !fits(longHeadLine, headRoom)) {
    headPart = partOfLine(longHeadLine, remaining(headRoom, head, headLines.count), false)
    head += headPart
  }
  const rest = lines.slice(headLines.count)
  const tailLines =
    headShare < 1 && rest.length ? wholeLines(rest, tailRoom, true) : { count: 0, text: '' }
  let tail = tailLines.text
  const longTailIndex = rest.length - 1 - tailLines.count
  if (
    headShare < 1 &&
    longTailIndex >= 0 &&
    tailLines.count < tailRoom.maxLines &&
    !fits(rest[longTailIndex], tailRoom)
  ) {
    // A line cut at both ends must not give the same characters twice.
    const line = rest[longTailIndex]
    const available = longTailIndex === 0 ? line.slice(headPart.length) : line
    tail = partOfLine(available, remaining(tailRoom, tail, tailLines.count), true) + tail
  }
  const omittedOffset = Buffer.byteLength(head, 'utf8')
  const omittedBytes = originalBytes - omittedOffset - Buffer.byteLength(tail, 'utf8')
  const omitted = Buffer.from(content, 'utf8')
    .subarray(omittedOffset, omittedOffset + omittedBytes)
    .toString('utf8')
  return {
    truncated: true,
    head,
    tail,
    originalBytes,
    omittedOffset,
    omittedBytes,
    omittedLines: omitted.split('\n').length - 1
  }
}

/** Plans the cut of one result against a tool's output policy. */
export function planToolOutputCut(content: string, policy: ToolOutputPolicy = {}): ToolOutputCut {
  return cutWithin(content, resolveLimits(policy), policy.preview ?? 'head-tail')
}

function amount(lines: number, bytes: number): string {
  const size = `${bytes.toLocaleString('en-US')} bytes`
  return lines > 0 ? `${lines.toLocaleString('en-US')} lines (${size})` : size
}

/** Joins the kept parts around the note, each on a line of its own. */
function compose(head: string, note: string, tail: string): string {
  const before = head && !head.endsWith('\n') ? `${head}\n` : head
  return `${before}${note}${tail ? `\n${tail}` : ''}`
}

/**
 * Bounds tool output for the model and keeps the rest on disk. Stored credential values are
 * redacted from everything it is given before any of it is measured, shown or written, so the
 * offsets it reports match the redacted text that is kept.
 */
export class ToolOutputStore {
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
    private readonly redactor: CredentialRedactor = credentialRedactor
  ) {}

  private path(handle: string): string {
    if (!HANDLE_PATTERN.test(handle)) throw new Error('Invalid tool output handle')
    return join(this.root, `${handle}.txt`)
  }

  /**
   * The handle in what the model sent. Models copy a handle with the quotes, spaces or the period
   * around it in a note; only the handle itself names a file, so nothing else gets through.
   */
  static handleFrom(value: unknown): string {
    const text = typeof value === 'string' ? value.trim() : ''
    const embedded = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.exec(
      text
    )?.[0]
    return embedded && text.replace(embedded, '').replace(/[\s"'`<>()[\].,;:]/g, '') === ''
      ? embedded
      : text
  }

  /** Keeps text the model was shown only part of, for reading on with `tool_output`. */
  async save(content: string): Promise<string> {
    await fs.mkdir(this.root, { recursive: true })
    const handle = randomUUID()
    await fs.writeFile(this.path(handle), this.redactor.redact(content), {
      encoding: 'utf8',
      mode: 0o600
    })
    return handle
  }

  async apply(rawContent: string, policy: ToolOutputPolicy = {}): Promise<BoundedToolOutput> {
    const content = this.redactor.redact(rawContent)
    const cut = planToolOutputCut(content, policy)
    const originalEstimatedTokens = estimateTextTokens(content)
    if (!cut.truncated) {
      return {
        content,
        output: {
          truncated: false,
          originalBytes: cut.originalBytes,
          returnedBytes: cut.originalBytes,
          originalEstimatedTokens,
          returnedEstimatedTokens: originalEstimatedTokens
        }
      }
    }
    const handle = await this.save(content)
    const note =
      `[… SideKick left out ${amount(cut.omittedLines, cut.omittedBytes)} here to keep this ` +
      `result short. The whole result is kept: read the part left out with tool_output, ` +
      `handle "${handle}" and offset ${cut.omittedOffset}, or look for text in it with find. …]`
    const shown = compose(cut.head, note, cut.tail)
    return {
      content: shown,
      output: {
        truncated: true,
        originalBytes: cut.originalBytes,
        returnedBytes: Buffer.byteLength(shown, 'utf8'),
        originalEstimatedTokens,
        returnedEstimatedTokens: estimateTextTokens(shown),
        fullOutputHandle: handle,
        continuation: { offset: cut.omittedOffset, bytes: cut.omittedBytes }
      }
    }
  }

  /**
   * Keeps a whole result and gives the model `shown(handle)` instead: a shorter form the tool made
   * itself, such as an outline of long JSON, which names the handle for reading the rest.
   */
  async keep(rawContent: string, shown: (handle: string) => string): Promise<BoundedToolOutput> {
    const content = this.redactor.redact(rawContent)
    const handle = await this.save(content)
    const text = this.redactor.redact(shown(handle))
    const originalBytes = Buffer.byteLength(content, 'utf8')
    return {
      content: text,
      output: {
        truncated: true,
        originalBytes,
        returnedBytes: Buffer.byteLength(text, 'utf8'),
        originalEstimatedTokens: estimateTextTokens(content),
        returnedEstimatedTokens: estimateTextTokens(text),
        fullOutputHandle: handle,
        continuation: { offset: 0, bytes: originalBytes }
      }
    }
  }

  /**
   * Bounds a result made of labelled sections, such as a command's stdout and stderr, each on its
   * own: a section that fits whole keeps it, and the others share the rest of the room, head and
   * tail on whole lines. The model reads `header`, then each section between `<name>` tags; the
   * stored output has the same layout with every section whole, so each note's offset points at
   * the first byte its section left out.
   */
  async applySections(
    rawHeader: string,
    rawSections: readonly ToolOutputSection[],
    options: {
      policy?: ToolOutputPolicy
      /** Says what was shortened, for example "SideKick shortened the output shown in the chat". */
      describeCut: (
        section: ToolOutputSection,
        amount: string,
        handle: string,
        offset: number
      ) => string
    }
  ): Promise<BoundedToolOutput & { sections: BoundedToolOutputSection[] }> {
    const header = this.redactor.redact(rawHeader)
    const sections = rawSections.map((section) => ({
      ...section,
      text: this.redactor.redact(section.text)
    }))
    const limits = resolveLimits(options.policy ?? {})
    const preview = options.policy?.preview ?? 'head-tail'
    const opening = header ? `${header}\n` : ''
    const layout = (bodies: readonly string[]): string =>
      opening +
      sections
        .map((section, index) => {
          const body = bodies[index]
          return `<${section.name}>\n${body}${body.endsWith('\n') || !body ? '' : '\n'}</${section.name}>\n`
        })
        .join('')
    const whole = layout(sections.map((section) => section.text))
    const originalEstimatedTokens = estimateTextTokens(whole)
    const originalBytes = Buffer.byteLength(whole, 'utf8')
    const untouched = {
      content: whole,
      output: {
        truncated: false,
        originalBytes,
        returnedBytes: originalBytes,
        originalEstimatedTokens,
        returnedEstimatedTokens: originalEstimatedTokens
      },
      sections: sections.map((section) => ({ name: section.name, truncated: false }))
    }
    if (linesOf(whole).length <= limits.maxLines && fits(whole, limits)) return untouched

    // The room left after the header and the tags, shared by the sections.
    const frame = layout(sections.map(() => ''))
    const room: CutLimits = {
      maxLines: Math.max(sections.length, limits.maxLines - linesOf(frame).length),
      maxBytes: Math.max(1_024, limits.maxBytes - Buffer.byteLength(frame, 'utf8')),
      maxTokens: Math.max(256, limits.maxTokens - estimateTextTokens(frame))
    }
    const usage = sections.map((section) => ({
      lines: linesOf(section.text).length,
      bytes: Buffer.byteLength(section.text, 'utf8'),
      tokens: estimateTextTokens(section.text)
    }))
    const even = scaled(room, 1 / sections.length)
    const small = usage.map(
      (use) =>
        use.lines <= even.maxLines && use.bytes <= even.maxBytes && use.tokens <= even.maxTokens
    )
    const spent = usage.reduce(
      (sum, use, index) =>
        small[index]
          ? {
              lines: sum.lines + use.lines,
              bytes: sum.bytes + use.bytes,
              tokens: sum.tokens + use.tokens
            }
          : sum,
      { lines: 0, bytes: 0, tokens: 0 }
    )
    const large = small.filter((value) => !value).length
    const share: CutLimits = scaled(
      {
        maxLines: Math.max(0, room.maxLines - spent.lines),
        maxBytes: Math.max(0, room.maxBytes - spent.bytes),
        maxTokens: Math.max(0, room.maxTokens - spent.tokens)
      },
      1 / Math.max(1, large)
    )
    const unbounded = { maxLines: Infinity, maxBytes: Infinity, maxTokens: Infinity }
    const cuts = sections.map((section, index) =>
      cutWithin(section.text, small[index] ? unbounded : share, preview)
    )
    if (!cuts.some((cut) => cut.truncated)) return untouched
    const handle = await this.save(whole)
    // Where each section's body starts in the stored output.
    let position = Buffer.byteLength(opening, 'utf8')
    const starts = sections.map((section) => {
      const start = position + Buffer.byteLength(`<${section.name}>\n`, 'utf8')
      const body = section.text
      position =
        start +
        Buffer.byteLength(body, 'utf8') +
        (body.endsWith('\n') || !body ? 0 : 1) +
        Buffer.byteLength(`</${section.name}>\n`, 'utf8')
      return start
    })
    const bodies = cuts.map((cut, index) => {
      if (!cut.truncated) return cut.head
      const offset = starts[index] + cut.omittedOffset
      const note = options.describeCut(
        sections[index],
        amount(cut.omittedLines, cut.omittedBytes),
        handle,
        offset
      )
      return compose(cut.head, `[… ${note} …]`, cut.tail)
    })
    const shown = layout(bodies)
    return {
      content: shown,
      output: {
        truncated: true,
        originalBytes,
        returnedBytes: Buffer.byteLength(shown, 'utf8'),
        originalEstimatedTokens,
        returnedEstimatedTokens: estimateTextTokens(shown),
        fullOutputHandle: handle,
        continuation: {
          offset: Math.min(
            ...cuts.map((cut, index) =>
              cut.truncated ? starts[index] + cut.omittedOffset : Number.POSITIVE_INFINITY
            )
          )
        }
      },
      sections: cuts.map((cut, index) => ({
        name: sections[index].name,
        truncated: cut.truncated,
        ...(cut.truncated
          ? {
              omittedOffset: starts[index] + cut.omittedOffset,
              omittedBytes: cut.omittedBytes,
              omittedLines: cut.omittedLines
            }
          : {})
      }))
    }
  }

  async read(
    handle: string,
    offset = 0,
    requestedMaxBytes = DEFAULT_MAX_BYTES
  ): Promise<ReadToolOutputResult> {
    const file = this.path(ToolOutputStore.handleFrom(handle))
    const stat = await fs.stat(file)
    if (!stat.isFile()) throw new Error('Tool output handle does not refer to a file')
    let start = Math.max(0, Math.min(stat.size, Math.trunc(offset)))
    const maxBytes = Math.max(1_024, Math.min(DEFAULT_MAX_BYTES, Math.trunc(requestedMaxBytes)))
    const descriptor = await fs.open(file, 'r')
    try {
      // An offset inside a character starts at that character, and a read ends on a whole one,
      // so no read shows a replacement character for half of one.
      if (start > 0 && start < stat.size) {
        const probe = Buffer.alloc(Math.min(4, start + 1))
        await descriptor.read(probe, 0, probe.length, start + 1 - probe.length)
        let index = probe.length - 1
        while (index > 0 && (probe[index] & 0xc0) === 0x80) index--
        start -= probe.length - 1 - index
      }
      const length = Math.min(maxBytes, stat.size - start)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await descriptor.read(buffer, 0, length, start)
      let end = bytesRead
      if (start + end < stat.size) {
        // Back off a character the read would cut in two.
        let lead = end - 1
        while (lead > 0 && (buffer[lead] & 0xc0) === 0x80) lead--
        const width =
          buffer[lead] >= 0xf0 ? 4 : buffer[lead] >= 0xe0 ? 3 : buffer[lead] >= 0xc0 ? 2 : 1
        if (lead + width > end) end = lead
      }
      const nextOffset = start + end < stat.size ? start + end : null
      // Output kept before a value was stored is redacted as it is read back. The text around
      // the window is read too, so a value crossing its edge is still recognised.
      const context = this.redactor.context * 4
      const before = Buffer.alloc(context ? Math.min(context, start) : 0)
      const after = Buffer.alloc(context ? Math.min(context, stat.size - (start + end)) : 0)
      if (before.length) await descriptor.read(before, 0, before.length, start - before.length)
      if (after.length) await descriptor.read(after, 0, after.length, start + end)
      const lead = before.toString('utf8')
      const window = buffer.subarray(0, end).toString('utf8')
      return {
        content: this.redactor.redactWindow(
          lead + window + after.toString('utf8'),
          lead.length,
          lead.length + window.length
        ),
        offset: start,
        nextOffset,
        totalBytes: stat.size
      }
    } finally {
      await descriptor.close()
    }
  }

  /**
   * Finds text in a kept output, ignoring case, so a model looking for one value in a long result
   * need not read it in pieces. The text is searched as a read would show it: a value stored since
   * the output was kept is hidden first, so a search cannot find what a read would not show. That
   * can move later offsets by the few bytes the placeholder differs, well within a read.
   */
  async search(
    handle: string,
    text: string,
    maxMatches = MAX_SEARCH_MATCHES
  ): Promise<SearchToolOutputResult> {
    const file = this.path(ToolOutputStore.handleFrom(handle))
    const content = this.redactor.redact(await fs.readFile(file, 'utf8'))
    const literal = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
    const matches: ToolOutputMatch[] = []
    let totalMatches = 0
    let counted = 0
    let countedBytes = 0
    for (const match of content.matchAll(literal)) {
      if (++totalMatches > MAX_COUNTED_MATCHES) {
        totalMatches = MAX_COUNTED_MATCHES
        break
      }
      if (matches.length >= maxMatches) continue
      countedBytes += Buffer.byteLength(content.slice(counted, match.index), 'utf8')
      counted = match.index
      const start = Math.max(0, match.index - MATCH_CONTEXT)
      const end = Math.min(content.length, match.index + match[0].length + MATCH_CONTEXT)
      const around = content.slice(start, end).replace(/\r?\n/g, ' ⏎ ')
      matches.push({
        offset: countedBytes,
        text: `${start > 0 ? '…' : ''}${around}${end < content.length ? '…' : ''}`
      })
    }
    return { matches, totalMatches, totalBytes: Buffer.byteLength(content, 'utf8') }
  }

  async cleanup(retentionMs = DEFAULT_RETENTION_MS): Promise<number> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    let removed = 0
    for (const entry of entries) {
      if (!entry.endsWith('.txt')) continue
      const file = join(this.root, entry)
      try {
        const stat = await fs.stat(file)
        if (this.now() - stat.mtimeMs <= retentionMs) continue
        await fs.unlink(file)
        removed++
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return removed
  }
}
