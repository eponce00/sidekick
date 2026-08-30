import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { ToolOutputReference } from '../../shared/agentRuntime'
import { estimateTextTokens } from '../../shared/contextBudget'

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

const DEFAULT_MAX_BYTES = 50 * 1024
const DEFAULT_MAX_LINES = 2_000
const DEFAULT_MAX_TOKENS = 8_192
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const HANDLE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function takeLines(
  content: string,
  maxLines: number,
  preview: NonNullable<ToolOutputPolicy['preview']>
): { content: string; truncated: boolean; omittedLines: number } {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length <= maxLines) return { content, truncated: false, omittedLines: 0 }
  const omittedLines = lines.length - maxLines
  if (preview === 'tail') {
    return { content: lines.slice(-maxLines).join('\n'), truncated: true, omittedLines }
  }
  if (preview === 'head-tail') {
    const head = Math.ceil(maxLines / 2)
    const tail = Math.floor(maxLines / 2)
    return {
      content: [
        ...lines.slice(0, head),
        `… ${omittedLines} lines omitted …`,
        ...lines.slice(-tail)
      ].join('\n'),
      truncated: true,
      omittedLines
    }
  }
  return { content: lines.slice(0, maxLines).join('\n'), truncated: true, omittedLines }
}

function takeBytes(
  content: string,
  maxBytes: number,
  preview: NonNullable<ToolOutputPolicy['preview']>
): { content: string; truncated: boolean } {
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.byteLength <= maxBytes) return { content, truncated: false }
  if (preview === 'tail') {
    return {
      content: bytes.subarray(bytes.byteLength - maxBytes).toString('utf8'),
      truncated: true
    }
  }
  if (preview === 'head-tail') {
    const head = Math.ceil(maxBytes / 2)
    const tail = Math.floor(maxBytes / 2)
    return {
      content:
        bytes.subarray(0, head).toString('utf8') +
        '\n… bytes omitted …\n' +
        bytes.subarray(bytes.byteLength - tail).toString('utf8'),
      truncated: true
    }
  }
  return { content: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

function tokenPreview(
  content: string,
  retainedCharacters: number,
  preview: NonNullable<ToolOutputPolicy['preview']>
): string {
  if (retainedCharacters <= 0) return ''
  if (preview === 'tail') return content.slice(-retainedCharacters)
  if (preview === 'head-tail') {
    const head = Math.ceil(retainedCharacters / 2)
    const tail = Math.floor(retainedCharacters / 2)
    return `${content.slice(0, head)}\n… tokens omitted …\n${tail ? content.slice(-tail) : ''}`
  }
  return content.slice(0, retainedCharacters)
}

function takeTokens(
  content: string,
  maxTokens: number,
  preview: NonNullable<ToolOutputPolicy['preview']>
): { content: string; truncated: boolean } {
  if (estimateTextTokens(content) <= maxTokens) return { content, truncated: false }
  let low = 0
  let high = content.length
  let best = ''
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = tokenPreview(content, middle, preview)
    if (estimateTextTokens(candidate) <= maxTokens) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return { content: best, truncated: true }
}

export function boundToolOutputPreview(
  content: string,
  policy: ToolOutputPolicy = {}
): {
  content: string
  truncated: boolean
  originalBytes: number
  returnedBytes: number
  originalEstimatedTokens: number
  returnedEstimatedTokens: number
} {
  const maxBytes = Math.max(1_024, policy.maxBytes ?? DEFAULT_MAX_BYTES)
  const maxLines = Math.max(1, policy.maxLines ?? DEFAULT_MAX_LINES)
  const maxTokens = Math.max(256, policy.maxTokens ?? DEFAULT_MAX_TOKENS)
  const preview = policy.preview ?? 'head-tail'
  const originalBytes = Buffer.byteLength(content, 'utf8')
  const originalEstimatedTokens = estimateTextTokens(content)
  const lineBounded = takeLines(content, maxLines, preview)
  const byteBounded = takeBytes(lineBounded.content, maxBytes, preview)
  const tokenBounded = takeTokens(byteBounded.content, maxTokens, preview)
  return {
    content: tokenBounded.content,
    truncated: lineBounded.truncated || byteBounded.truncated || tokenBounded.truncated,
    originalBytes,
    returnedBytes: Buffer.byteLength(tokenBounded.content, 'utf8'),
    originalEstimatedTokens,
    returnedEstimatedTokens: estimateTextTokens(tokenBounded.content)
  }
}

export class ToolOutputStore {
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now
  ) {}

  private path(handle: string): string {
    if (!HANDLE_PATTERN.test(handle)) throw new Error('Invalid tool output handle')
    return join(this.root, `${handle}.txt`)
  }

  async apply(content: string, policy: ToolOutputPolicy = {}): Promise<BoundedToolOutput> {
    const bounded = boundToolOutputPreview(content, policy)
    if (!bounded.truncated) {
      return {
        content: bounded.content,
        output: {
          truncated: false,
          originalBytes: bounded.originalBytes,
          returnedBytes: bounded.returnedBytes,
          originalEstimatedTokens: bounded.originalEstimatedTokens,
          returnedEstimatedTokens: bounded.returnedEstimatedTokens
        }
      }
    }
    await fs.mkdir(this.root, { recursive: true })
    const handle = randomUUID()
    await fs.writeFile(this.path(handle), content, { encoding: 'utf8', mode: 0o600 })
    const hint =
      `\n\n[Output truncated: ${bounded.originalBytes - bounded.returnedBytes} bytes omitted; ` +
      `approximately ${bounded.originalEstimatedTokens - bounded.returnedEstimatedTokens} tokens omitted. ` +
      `Full output handle: ${handle}. Use tool_output with an offset and max_bytes.]`
    return {
      content: bounded.content + hint,
      output: {
        truncated: true,
        originalBytes: bounded.originalBytes,
        returnedBytes: bounded.returnedBytes,
        originalEstimatedTokens: bounded.originalEstimatedTokens,
        returnedEstimatedTokens: bounded.returnedEstimatedTokens,
        fullOutputHandle: handle,
        continuation: { offset: bounded.returnedBytes }
      }
    }
  }

  async read(
    handle: string,
    offset = 0,
    requestedMaxBytes = DEFAULT_MAX_BYTES
  ): Promise<ReadToolOutputResult> {
    const file = this.path(handle)
    const stat = await fs.stat(file)
    if (!stat.isFile()) throw new Error('Tool output handle does not refer to a file')
    const start = Math.max(0, Math.min(stat.size, Math.trunc(offset)))
    const maxBytes = Math.max(1_024, Math.min(DEFAULT_MAX_BYTES, Math.trunc(requestedMaxBytes)))
    const length = Math.min(maxBytes, stat.size - start)
    const descriptor = await fs.open(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await descriptor.read(buffer, 0, length, start)
      const nextOffset = start + bytesRead < stat.size ? start + bytesRead : null
      return {
        content: buffer.subarray(0, bytesRead).toString('utf8'),
        offset: start,
        nextOffset,
        totalBytes: stat.size
      }
    } finally {
      await descriptor.close()
    }
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
