import { createHash } from 'crypto'
import type {
  WorkspaceFileChange,
  WorkspaceFileChangeAction
} from '../../shared/workspaceMutations'

const MAX_FILE_DIFF_CHARACTERS = 64_000

function normalizedLines(content: string | undefined): string[] {
  if (content === undefined || content === '') return []
  const normalized = content.replace(/\r\n/g, '\n')
  return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n')
}

function hash(content: string | undefined): string | undefined {
  return content === undefined ? undefined : createHash('sha256').update(content).digest('hex')
}

function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`
}

export function createUnifiedFileDiff(input: {
  path: string
  movePath?: string
  before?: string
  after?: string
}): { diff: string; additions: number; deletions: number; diffTruncated: boolean } {
  const beforeLines = normalizedLines(input.before)
  const afterLines = normalizedLines(input.after)
  let prefix = 0
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++
  }
  const newlineOnlyChange =
    prefix === beforeLines.length &&
    prefix === afterLines.length &&
    input.before !== undefined &&
    input.after !== undefined &&
    input.before.endsWith('\n') !== input.after.endsWith('\n') &&
    prefix > 0
  if (newlineOnlyChange) prefix--
  let suffix = 0
  while (
    !newlineOnlyChange &&
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const removed = beforeLines.slice(prefix, beforeLines.length - suffix)
  const added = afterLines.slice(prefix, afterLines.length - suffix)
  const contextBefore = beforeLines.slice(Math.max(0, prefix - 3), prefix)
  const contextAfter = beforeLines.slice(
    beforeLines.length - suffix,
    beforeLines.length - suffix + 3
  )
  const oldStart = input.before === undefined ? 0 : Math.max(1, prefix - contextBefore.length + 1)
  const newStart = input.after === undefined ? 0 : Math.max(1, prefix - contextBefore.length + 1)
  const oldCount = contextBefore.length + removed.length + contextAfter.length
  const newCount = contextBefore.length + added.length + contextAfter.length
  const oldName = input.before === undefined ? '/dev/null' : `a/${input.path}`
  const newName = input.after === undefined ? '/dev/null' : `b/${input.movePath ?? input.path}`
  const body = [
    ...contextBefore.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...contextAfter.map((line) => ` ${line}`)
  ]
  if (input.before !== undefined && !input.before.endsWith('\n')) {
    const lastRemoved = body.findLastIndex((line) => line.startsWith('-'))
    if (lastRemoved >= 0) body.splice(lastRemoved + 1, 0, '\\ No newline at end of file')
  }
  if (input.after !== undefined && !input.after.endsWith('\n')) {
    const lastAdded = body.findLastIndex((line) => line.startsWith('+'))
    if (lastAdded >= 0) body.splice(lastAdded + 1, 0, '\\ No newline at end of file')
  }
  const header = [
    `--- ${oldName}`,
    `+++ ${newName}`,
    `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`
  ]
  const rendered: string[] = [...header]
  let renderedLength = header.reduce((total, line) => total + line.length + 1, 0)
  let diffTruncated = false
  for (const line of body) {
    if (renderedLength + line.length + 1 > MAX_FILE_DIFF_CHARACTERS) {
      diffTruncated = true
      break
    }
    rendered.push(line)
    renderedLength += line.length + 1
  }
  if (diffTruncated) {
    rendered.push(
      `... diff preview truncated; exact totals: +${added.length} -${removed.length} ...`
    )
  }
  return {
    diff: rendered.join('\n'),
    additions: added.length,
    deletions: removed.length,
    diffTruncated
  }
}

export function createWorkspaceFileChange(input: {
  path: string
  action: WorkspaceFileChangeAction
  movePath?: string
  before?: string
  after?: string
}): WorkspaceFileChange {
  const generated = createUnifiedFileDiff(input)
  return {
    path: input.path,
    action: input.action,
    movePath: input.movePath,
    additions: generated.additions,
    deletions: generated.deletions,
    diff: generated.diff,
    diffTruncated: generated.diffTruncated || undefined,
    beforeHash: hash(input.before),
    afterHash: hash(input.after)
  }
}
