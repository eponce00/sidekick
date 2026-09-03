import {
  Ban,
  Bot,
  Check,
  CircleAlert,
  ChevronRight,
  Clock3,
  Code2,
  FilePenLine,
  FilePlus2,
  FileText,
  Files,
  FolderSearch2,
  Globe2,
  Images,
  Layers3,
  ListTodo,
  Loader2,
  Plug,
  Search,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  X
} from 'lucide-react'
import type { ToolExecution } from '../types/chat.types'
import {
  getCompactToolTitle,
  getToolApprovalLabel,
  getToolKind,
  getToolStatusLabel,
  type ToolKind
} from '../utils/toolPresentation'

const ICON_SIZE = 14

function ToolKindIcon({ kind }: { kind: ToolKind }): React.JSX.Element {
  switch (kind) {
    case 'artifact':
      return <Code2 size={ICON_SIZE} />
    case 'terminal':
      return <Terminal size={ICON_SIZE} />
    case 'search':
      return <Search size={ICON_SIZE} />
    case 'image-search':
      return <Images size={ICON_SIZE} />
    case 'browser':
      return <Globe2 size={ICON_SIZE} />
    case 'files':
      return <Files size={ICON_SIZE} />
    case 'file-read':
      return <FileText size={ICON_SIZE} />
    case 'file-write':
      return <FilePlus2 size={ICON_SIZE} />
    case 'file-edit':
      return <FilePenLine size={ICON_SIZE} />
    case 'file-delete':
      return <Trash2 size={ICON_SIZE} />
    case 'file-search':
      return <FolderSearch2 size={ICON_SIZE} />
    case 'subagent':
      return <Bot size={ICON_SIZE} />
    case 'compaction':
      return <Layers3 size={ICON_SIZE} />
    case 'skill':
      return <Sparkles size={ICON_SIZE} />
    case 'task':
      return <ListTodo size={ICON_SIZE} />
    case 'wait':
      return <Clock3 size={ICON_SIZE} />
    case 'mcp':
      return <Plug size={ICON_SIZE} />
    case 'generic':
      return <Wrench size={ICON_SIZE} />
  }
}

function ToolStatusIcon({ status }: { status: ToolExecution['status'] }): React.JSX.Element {
  switch (status) {
    case 'running':
      return <Loader2 size={ICON_SIZE} className="icon-spin" />
    case 'success':
      return <Check size={ICON_SIZE} />
    case 'partial':
      return <CircleAlert size={ICON_SIZE} />
    case 'error':
      return <X size={ICON_SIZE} />
    case 'denied':
      return <Ban size={ICON_SIZE} />
    case 'pending':
      return <Clock3 size={ICON_SIZE} />
  }
}

interface ToolCallRowProps {
  tool: ToolExecution
  onSelect?: () => void
  expandable?: boolean
  expanded?: boolean
}

export default function ToolCallRow({
  tool,
  onSelect,
  expandable = false,
  expanded = false
}: ToolCallRowProps): React.JSX.Element {
  const kind = getToolKind(tool)
  const compactTitle = getCompactToolTitle(tool)
  const statusLabel = getToolStatusLabel(tool.status)
  const approvalLabel = getToolApprovalLabel(tool)
  const interactive = Boolean(onSelect)
  const hoverDetail = [
    compactTitle !== tool.title ? tool.title : '',
    tool.error ?? '',
    tool.hint ?? ''
  ]
    .filter(Boolean)
    .join(' — ')
  const hoverTitle = [hoverDetail || compactTitle, approvalLabel ?? statusLabel]
    .filter(Boolean)
    .join(' — ')

  return (
    <button
      type="button"
      className={`tool-call-row tool-call-row-${tool.status} ${interactive ? 'tool-call-row-interactive' : ''}`}
      onClick={onSelect}
      aria-label={`${compactTitle}. ${approvalLabel ?? statusLabel}`}
      aria-disabled={!interactive}
      aria-expanded={expandable ? expanded : undefined}
      tabIndex={interactive ? 0 : -1}
      title={hoverTitle}
    >
      <span className={`tool-call-kind tool-call-kind-${kind}`} aria-hidden="true">
        <ToolKindIcon kind={kind} />
      </span>
      <span className="tool-call-copy">
        <span className="tool-call-title">{compactTitle}</span>
      </span>
      {approvalLabel && (
        <span className={`tool-call-approval tool-call-approval-${tool.approvalStatus}`}>
          {approvalLabel}
        </span>
      )}
      <span className="tool-call-state" title={statusLabel} aria-hidden="true">
        <ToolStatusIcon status={tool.status} />
      </span>
      {expandable ? (
        <span
          className={`tool-call-chevron ${expanded ? 'tool-call-chevron-expanded' : ''}`}
          aria-hidden="true"
        >
          <ChevronRight size={ICON_SIZE} />
        </span>
      ) : null}
    </button>
  )
}
