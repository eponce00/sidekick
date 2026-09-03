import type { ToolExecution } from '../types/chat.types'

export type ToolKind =
  | 'artifact'
  | 'terminal'
  | 'search'
  | 'image-search'
  | 'browser'
  | 'files'
  | 'file-read'
  | 'file-write'
  | 'file-edit'
  | 'file-delete'
  | 'file-search'
  | 'subagent'
  | 'compaction'
  | 'skill'
  | 'task'
  | 'wait'
  | 'mcp'
  | 'generic'

function toolIdentifier(tool: Pick<ToolExecution, 'name' | 'command' | 'title'>): string {
  return `${tool.name ?? ''} ${tool.command ?? ''} ${tool.title}`.toLowerCase()
}

function compactText(value: unknown, maxLength: number): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= maxLength) return text
  const clipped = text.slice(0, maxLength - 1).trimEnd()
  const lastSpace = clipped.lastIndexOf(' ')
  const cleanCut = lastSpace >= Math.floor(maxLength * 0.65) ? clipped.slice(0, lastSpace) : clipped
  return `${cleanCut}…`
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
}

function argumentValue(
  tool: Pick<ToolExecution, 'command' | 'input' | 'title'>,
  key: string
): string {
  const inputValue = tool.input?.[key]
  if (typeof inputValue === 'string' && inputValue.trim()) return inputValue

  const commandMatch = tool.command?.match(/\(\s*(["'])(.*?)\1\s*\)/)
  if (commandMatch?.[2]) return commandMatch[2]
  return ''
}

function searchQuery(tool: Pick<ToolExecution, 'command' | 'input' | 'title'>): string {
  const argument = argumentValue(tool, 'query')
  if (argument) return argument
  return stripWrappingQuotes(
    tool.title.replace(/^(?:searching|searched|image search)(?:\s+for)?\s*:\s*/i, '')
  )
}

function workspaceValue(
  tool: Pick<ToolExecution, 'command' | 'input' | 'title'>,
  inputKey: string,
  titlePrefix: RegExp
): string {
  const inputValue = tool.input?.[inputKey]
  if (typeof inputValue === 'string' && inputValue.trim()) return inputValue
  return stripWrappingQuotes(tool.title.replace(titlePrefix, ''))
}

function shortFilePath(value: string): string {
  if (!value.trim()) return 'file'
  const normalized = value.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 2) return compactText(value, 42)
  return `…/${parts.slice(-2).join('/')}`
}

function websiteHost(tool: Pick<ToolExecution, 'command' | 'input' | 'title'>): string {
  const inputUrl = tool.input?.url
  const source =
    (typeof inputUrl === 'string' ? inputUrl : '') ||
    tool.command?.match(/https?:\/\/[^\s"')]+/)?.[0] ||
    tool.title.match(/https?:\/\/[^\s"')]+/)?.[0] ||
    ''
  try {
    return new URL(source).hostname.replace(/^www\./, '')
  } catch {
    return 'web page'
  }
}

export function getToolKind(tool: Pick<ToolExecution, 'name' | 'command' | 'title'>): ToolKind {
  const intent = (tool as Pick<ToolExecution, 'presentation'>).presentation
  if (intent) {
    const mapped: Partial<Record<typeof intent.kind, ToolKind>> = {
      generic: 'generic',
      terminal: 'terminal',
      read: 'file-read',
      diff: 'file-edit',
      search: tool.name === 'web_image_search' ? 'image-search' : 'search',
      web: 'browser',
      files: 'files',
      artifact: 'artifact',
      task: 'task',
      subagent: 'subagent'
    }
    return mapped[intent.kind] ?? 'generic'
  }
  const identifier = toolIdentifier(tool)

  if (/create_artifact|creating .*artifact/.test(identifier)) return 'artifact'
  if (/web_image_search|image search/.test(identifier)) return 'image-search'
  if (/web_search|searching:/.test(identifier)) return 'search'
  if (/web_fetch|fetching:|extracting .* from:/.test(identifier)) return 'browser'
  if (/^read\b|reading /.test(identifier)) return 'file-read'
  if (/\bwrite\b|writing /.test(identifier)) return 'file-write'
  if (/apply_patch|search_replace|\bedit\b|editing /.test(identifier)) return 'file-edit'
  if (/delete_file|deleting /.test(identifier)) return 'file-delete'
  if (/searching for /.test(identifier)) return 'file-search'
  if (/listing workspace files/.test(identifier)) return 'files'
  if (/spawn_subagent|sub-agent:/.test(identifier)) return 'subagent'
  if (/context_compaction|compacting context/.test(identifier)) return 'compaction'
  if (/use_skill|skill loaded/.test(identifier)) return 'skill'
  if (/todo|background_task/.test(identifier)) return 'task'
  if (tool.name === 'wait' || /^wait(?:ing|ed)?\b|\bsleep\b/.test(identifier)) return 'wait'
  if (/^mcp[:_\s-]|\bmcp[:_\s-]/.test(identifier)) return 'mcp'
  if (tool.name === 'shell' || tool.command) return 'terminal'

  return 'generic'
}

export function getToolStatusLabel(status: ToolExecution['status']): string {
  switch (status) {
    case 'pending':
      return 'Pending'
    case 'running':
      return 'Running'
    case 'success':
      return 'Completed'
    case 'partial':
      return 'Partially completed'
    case 'error':
      return 'Failed'
    case 'denied':
      return 'Denied'
  }
}

export function getCompactToolTitle(
  tool: Pick<ToolExecution, 'name' | 'command' | 'title' | 'input' | 'status' | 'presentation'>
): string {
  if (tool.presentation?.title) return compactText(tool.presentation.title, 64)
  const kind = getToolKind(tool)
  const completed = tool.status === 'success'
  const running = tool.status === 'running'

  switch (kind) {
    case 'artifact': {
      const title = compactText(tool.title.replace(/^creating\s+/i, ''), 42)
      return `${completed ? 'Created' : running ? 'Creating' : 'Create'} ${title}`
    }
    case 'search': {
      const query = compactText(searchQuery(tool), 34)
      return query ? `${completed ? 'Searched' : 'Searching'} “${query}”` : 'Web search'
    }
    case 'image-search': {
      const query = compactText(searchQuery(tool), 34)
      return query
        ? `${completed ? 'Found images for' : 'Finding images for'} “${query}”`
        : 'Image search'
    }
    case 'browser':
      return `${completed ? 'Read' : 'Reading'} ${websiteHost(tool)}`
    case 'files':
      return completed
        ? 'Listed workspace files'
        : running
          ? 'Listing workspace files'
          : 'List files'
    case 'file-read':
      return `${completed ? 'Read' : running ? 'Reading' : 'Read'} ${shortFilePath(workspaceValue(tool, 'path', /^reading\s+/i))}`
    case 'file-write':
      return `${completed ? 'Wrote' : running ? 'Writing' : 'Write'} ${shortFilePath(workspaceValue(tool, 'file_path', /^writing\s+/i))}`
    case 'file-edit':
      if (tool.name === 'apply_patch') {
        return completed
          ? 'Applied project patch'
          : running
            ? 'Applying project patch'
            : 'Apply patch'
      }
      return `${completed ? 'Edited' : running ? 'Editing' : 'Edit'} ${shortFilePath(workspaceValue(tool, 'file_path', /^editing\s+/i))}`
    case 'file-delete':
      return `${completed ? 'Deleted' : running ? 'Deleting' : 'Delete'} ${shortFilePath(workspaceValue(tool, 'file_path', /^deleting\s+/i))}`
    case 'file-search': {
      const pattern = compactText(workspaceValue(tool, 'regex', /^searching for\s+/i), 38)
      return pattern ? `Find “${pattern}” in files` : 'Search workspace files'
    }
    case 'subagent':
      return `Delegate · ${compactText(tool.title.replace(/^sub-agent:\s*/i, ''), 42)}`
    case 'compaction':
      return 'Compact context'
    case 'skill':
      return 'Load skill'
    case 'terminal':
      if (/^(?:executing|execute|running|run) command$/i.test(tool.title.trim())) {
        return completed ? 'Ran command' : running ? 'Running command' : 'Run command'
      }
      if (tool.title.startsWith('Running: ')) {
        const detail = compactText(tool.title.slice('Running: '.length), 40)
        return completed ? `Ran · ${detail}` : running ? `Running · ${detail}` : detail
      }
      return compactText(tool.title, 52)
    case 'wait': {
      const rawSeconds = Number(tool.input?.seconds)
      const seconds = Number.isFinite(rawSeconds) ? Math.max(1, Math.min(200, rawSeconds)) : null
      const reason = compactText(tool.input?.reason, 34)
      if (tool.status === 'error') return 'Wait interrupted'
      const label = completed ? 'Waited' : running ? 'Waiting' : 'Wait'
      return `${label}${seconds === null ? '' : ` ${seconds}s`}${reason ? ` · ${reason}` : ''}`
    }
    case 'task':
    case 'mcp':
    case 'generic':
      return compactText(tool.title, 52)
  }
}

export function getToolApprovalLabel(
  tool: Pick<ToolExecution, 'accessLevel' | 'approvalStatus'>
): string | null {
  if (tool.accessLevel !== 'confirm') return null
  if (tool.approvalStatus === 'pending') return 'Approval needed'
  if (tool.approvalStatus === 'approved') return 'Approved'
  if (tool.approvalStatus === 'denied') return 'Denied'
  return null
}
