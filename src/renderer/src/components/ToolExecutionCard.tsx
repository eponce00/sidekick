import { useMemo, useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import type { ToolExecution } from '../types/chat.types'
import { resolveToolView } from '../services/uiContributions'
import ToolCallRow from './ToolCallRow'
import { RichDiffBlock } from './RichDiffBlock'
import {
  AnsiTerminalOutput,
  FileListOutput,
  JsonTreeView,
  ReadFileOutput,
  SearchResultsOutput,
  WebPageOutput
} from './StructuredToolOutput'
import './ToolExecutionCard.css'

function boundedLines(
  output: string,
  expanded: boolean
): { text: string; omitted: number; total: number } {
  const lines = output.split(/\r?\n/)
  const omitted = Math.max(0, lines.length - 20)
  return {
    total: lines.length,
    omitted,
    text:
      omitted > 0 && !expanded
        ? [...lines.slice(0, 10), `… ${omitted} lines omitted …`, ...lines.slice(-10)].join('\n')
        : output
  }
}

export function ToolExecutionCard({
  tool,
  workspaceRoot
}: {
  tool: ToolExecution
  workspaceRoot?: string | null
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [copied, setCopied] = useState(false)
  const view = resolveToolView(tool)
  const output = tool.error || tool.output || ''
  const bounded = useMemo(() => boundedLines(output, showAll), [output, showAll])
  const command = typeof tool.input?.command === 'string' ? tool.input.command : tool.command
  const subject = tool.presentation?.subject
  const detail = tool.presentation?.detail || tool.hint
  const readPath = typeof tool.input?.path === 'string' ? tool.input.path : subject
  const dataRecord =
    tool.data && typeof tool.data === 'object' ? (tool.data as Record<string, unknown>) : null
  const hasReadOutput = typeof dataRecord?.content === 'string'
  const hasSearchOutput = Array.isArray(dataRecord?.results) && dataRecord.results.length > 0
  const hasWebOutput = Boolean(dataRecord && (dataRecord.url || dataRecord.content))
  const hasFileListOutput = Array.isArray(dataRecord?.files) && dataRecord.files.length > 0
  const expandable = Boolean(
    command || detail || subject || output || tool.changes?.length || tool.diagnostics?.length
  )

  return (
    <div className={`tool-execution-card tool-execution-card-${tool.status} is-${view}`}>
      <ToolCallRow
        tool={tool}
        onSelect={expandable ? () => setExpanded((current) => !current) : undefined}
        expandable={expandable}
        expanded={expanded}
      />
      {expanded && (
        <div className="tool-execution-detail">
          {subject && (
            <div
              className={`rich-tool-subject ${workspaceRoot && ['read', 'diff', 'files'].includes(view) ? 'is-openable' : ''}`}
              onClick={() => {
                if (workspaceRoot && ['read', 'diff', 'files'].includes(view)) {
                  void window.api.workspace.openFile(subject, workspaceRoot)
                }
              }}
              onContextMenu={(event) => {
                if (!workspaceRoot || !['read', 'diff', 'files'].includes(view)) return
                event.preventDefault()
                void window.api.workspace.showPathMenu(subject, workspaceRoot)
              }}
            >
              <ExternalLink size={11} />
              {subject}
            </div>
          )}
          {detail && view !== 'terminal' && <div className="rich-tool-detail">{detail}</div>}
          {view === 'diff' ? (
            <RichDiffBlock tool={tool} />
          ) : view === 'read' && hasReadOutput ? (
            <ReadFileOutput data={tool.data} path={readPath} workspaceRoot={workspaceRoot} />
          ) : view === 'search' && hasSearchOutput ? (
            <SearchResultsOutput data={tool.data} />
          ) : view === 'web' && hasWebOutput ? (
            <WebPageOutput data={tool.data} />
          ) : view === 'files' && hasFileListOutput ? (
            <FileListOutput data={tool.data} workspaceRoot={workspaceRoot} />
          ) : (
            <>
              {view === 'terminal' && command && (
                <div className="rich-tool-command">
                  <span>$</span>
                  <code>{command}</code>
                </div>
              )}
              {output && view === 'terminal' && (
                <div className={`rich-tool-output is-${view}`}>
                  <button
                    type="button"
                    className="rich-tool-copy"
                    onClick={() => {
                      void navigator.clipboard.writeText(output).then(() => {
                        setCopied(true)
                        window.setTimeout(() => setCopied(false), 1_000)
                      })
                    }}
                  >
                    {copied ? <Check size={11} /> : <Copy size={11} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <AnsiTerminalOutput value={bounded.text} />
                </div>
              )}
              {output && view !== 'terminal' && (
                <div className={`rich-tool-output is-${view}`}>
                  <button
                    type="button"
                    className="rich-tool-copy"
                    onClick={() => {
                      void navigator.clipboard.writeText(output).then(() => {
                        setCopied(true)
                        window.setTimeout(() => setCopied(false), 1_000)
                      })
                    }}
                  >
                    {copied ? <Check size={11} /> : <Copy size={11} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <pre>{bounded.text}</pre>
                </div>
              )}
              {!output && tool.data !== undefined && view === 'generic' && (
                <JsonTreeView value={tool.data} />
              )}
              {bounded.omitted > 0 && (
                <button
                  type="button"
                  className="tool-output-expand"
                  onClick={() => setShowAll((value) => !value)}
                >
                  {showAll ? 'Show summary' : `Show all ${bounded.total} lines`}
                </button>
              )}
            </>
          )}
          {tool.diagnostics && tool.diagnostics.length > 0 && (
            <div className="rich-tool-diagnostics">
              {tool.diagnostics.slice(0, 20).map((diagnostic, index) => (
                <div
                  key={`${diagnostic.filePath}-${diagnostic.line}-${index}`}
                  className={`is-${diagnostic.severity}`}
                >
                  <span>{diagnostic.severity}</span>
                  <span>
                    {diagnostic.filePath}
                    {diagnostic.line ? `:${diagnostic.line}` : ''}
                  </span>
                  <strong>{diagnostic.message}</strong>
                </div>
              ))}
            </div>
          )}
          {tool.outputReference?.truncated && (
            <div className="rich-tool-truncation">
              Preview bounded to{' '}
              {tool.outputReference.returnedBytes?.toLocaleString() || 'a safe size'} bytes. The
              complete output remains available to the agent.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
