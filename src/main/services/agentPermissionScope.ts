import { posix } from 'path'
import { isWorkspaceMutationTool } from '../../shared/workspaceMutations'

/**
 * What an "Allow for this chat" approval covers. Every key must already be
 * granted for a later request to skip the prompt, so a grant never reaches a
 * different command, a different path, or a different kind of change.
 */
export interface AgentPermissionScope {
  keys: string[]
  /** Short description for the approval card, such as "edits to src/app.ts". */
  label: string
}

const SEPARATOR = '\u0000'

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)])
    )
  }
  return value
}

/**
 * Only spelling is normalized: separators, `.` segments and a trailing slash.
 * Case is kept, so on a case-insensitive disk a grant can only be narrower
 * than the file, never wider.
 */
function normalizedPath(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().replaceAll('\\', '/') : ''
  if (!raw) return ''
  const normalized = posix.normalize(raw).replace(/\/+$/, '')
  return normalized === '' ? '/' : normalized
}

function patchTargets(patch: unknown): Array<{ action: 'edit' | 'delete'; path: string }> | null {
  if (typeof patch !== 'string') return null
  const targets: Array<{ action: 'edit' | 'delete'; path: string }> = []
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trim())
    if (!match) continue
    const path = normalizedPath(match[2])
    if (!path) return null
    targets.push({ action: match[1] === 'Delete File' ? 'delete' : 'edit', path })
  }
  return targets.length ? targets : null
}

function fileScope(
  targets: Array<{ action: 'edit' | 'delete'; path: string }>
): AgentPermissionScope {
  const unique = [
    ...new Map(targets.map((target) => [`${target.action}:${target.path}`, target])).values()
  ]
  const deletes = unique.every(({ action }) => action === 'delete')
  const noun = deletes
    ? 'deleting'
    : unique.some(({ action }) => action === 'delete')
      ? 'changes to'
      : 'edits to'
  return {
    keys: unique.map(({ action, path }) => ['file', action, path].join(SEPARATOR)),
    label:
      unique.length === 1 ? `${noun} ${unique[0].path}` : `${noun} these ${unique.length} files`
  }
}

/**
 * Scope of a sensitive tool call for a chat-wide approval: the exact command
 * with its directory for shell, the paths for file changes, and the exact
 * arguments for anything else. Undefined when no safe scope can be named.
 */
export function agentPermissionScope(
  name: string,
  args: Record<string, unknown>
): AgentPermissionScope | undefined {
  if (name === 'shell') {
    const command = typeof args.command === 'string' ? args.command.trim() : ''
    if (!command) return undefined
    const cwd = normalizedPath(args.cwd) || '.'
    return {
      keys: [
        ['shell', cwd, args.background === true ? 'background' : 'foreground', command].join(
          SEPARATOR
        )
      ],
      label: 'this exact command'
    }
  }
  if (name === 'apply_patch') {
    const targets = patchTargets(args.patch)
    return targets ? fileScope(targets) : undefined
  }
  if (isWorkspaceMutationTool(name)) {
    const path = normalizedPath(args.file_path ?? args.path)
    if (!path) return undefined
    return fileScope([{ action: name === 'delete_file' ? 'delete' : 'edit', path }])
  }
  return {
    keys: [['tool', name, JSON.stringify(stableValue(args))].join(SEPARATOR)],
    label: 'this exact action'
  }
}
