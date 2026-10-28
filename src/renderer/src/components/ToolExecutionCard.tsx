import { useMemo, useState } from 'react'
import { ExternalLink, SquareTerminal } from 'lucide-react'
import type { ToolExecution } from '../types/chat.types'
import { resolveToolView } from '../services/uiContributions'
import ToolCallRow from './ToolCallRow'
import { RichDiffBlock } from './RichDiffBlock'
import {
  AnsiTerminalOutput,
  CodeExcerpt,
  FileListOutput,
  JsonTreeView,
  ReadFileOutput,
  SearchResultsOutput,
  WebPageOutput
} from './StructuredToolOutput'
import { parseNumberedLines } from '../utils/codeHighlight'
import { CommandLiveView } from './CommandLiveView'
import { requestTerminalView, useTerminalSessionForTool } from '../utils/terminalSessionStore'
import { terminalSessionIsLive } from '../../../shared/terminalSessions'
import { Reveal } from './Reveal'
import { CommandCopyButton, CommandResultOutput } from './CommandResultOutput'
import { commandResultFrom } from '../utils/commandResult'
import { SurfaceImage } from './SurfaceImage'
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
  const [imageEnlarged, setImageEnlarged] = useState(false)
  // A running command's live view is its open detail; the row folds it away like any other.
  const [liveHidden, setLiveHidden] = useState(false)
  const view = resolveToolView(tool)
  const terminalSession = useTerminalSessionForTool(view === 'terminal' ? tool.id : undefined)
  const output = tool.error || tool.output || ''
  const bounded = useMemo(() => boundedLines(output, showAll), [output, showAll])
  // Saved pages of a file read keep the read tool's `12: text` lines; show them as code.
  const numberedOutput = useMemo(
    () => (view === 'terminal' ? null : parseNumberedLines(output)),
    [output, view]
  )
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
  // A finished command: shown from its recorded streams, not from the agent's shortened copy.
  const commandResult = view === 'terminal' ? commandResultFrom(tool.data) : null
  // An image the agent looked at, kept as a reduced copy in the app's own image store.
  const previewUrl =
    typeof dataRecord?.previewUrl === 'string' &&
    dataRecord.previewUrl.startsWith('sidekick-browser://artifact/')
      ? dataRecord.previewUrl
      : null
  const expandable = Boolean(
    command || detail || subject || output || tool.changes?.length || tool.diagnostics?.length
  )
  // A command shows itself once, as the header of its result box; a caption repeating it said
  // the same thing twice.
  const shownSubject = view === 'terminal' && command ? undefined : subject
  // The command line heads its result box, with the box's own actions (Copy, Open in Terminal) at
  // its end, so the rows under it carry only how the command ended and what it printed.
  const renderCommandHeader = (copy?: React.ReactNode): React.ReactNode =>
    view === 'terminal' && command ? (
      <div className="rich-tool-command">
        <span aria-hidden="true">$</span>
        <code>{command}</code>
        {(copy || terminalSession) && (
          <span className="rich-tool-command-actions">
            {copy}
            {terminalSession ? (
              <button
                type="button"
                className="settings-ghost-action is-small is-icon rich-tool-open-terminal"
                onClick={() => requestTerminalView(terminalSession.id)}
                aria-label="Open in Terminal"
                title="Open in Terminal"
              >
                <SquareTerminal size={13} />
              </button>
            ) : (
              // Its slot stays, so Copy sits at one offset on every command box.
              <span className="rich-tool-action-slot" aria-hidden="true" />
            )}
          </span>
        )}
      </div>
    ) : null
  const commandHeader = renderCommandHeader()
  // While the command runs, its live view under the row already carries the command line.
  const commandLive = Boolean(terminalSession && terminalSessionIsLive(terminalSession.state))
  // The chevron says whether the step's detail is on screen: the live view while it runs, the
  // result once it has finished.
  const detailShown = commandLive ? !liveHidden : expanded

  return (
    <div className={`tool-execution-card tool-execution-card-${tool.status} is-${view}`}>
      <ToolCallRow
        tool={tool}
        onSelect={
          expandable
            ? () =>
                commandLive
                  ? setLiveHidden((current) => !current)
                  : setExpanded((current) => !current)
            : undefined
        }
        expandable={expandable}
        expanded={detailShown}
      />
      {view === 'terminal' && !(commandLive && liveHidden) && (
        <CommandLiveView toolCallId={tool.id} />
      )}
      {previewUrl && (
        <button
          type="button"
          className={`tool-image-preview${imageEnlarged ? ' is-enlarged' : ''}`}
          onClick={() => setImageEnlarged((value) => !value)}
          aria-label={imageEnlarged ? 'Show the image smaller' : 'Show the image larger'}
          title={subject || readPath}
        >
          <SurfaceImage
            src={previewUrl}
            alt={`Image the agent viewed: ${subject || readPath || ''}`}
            loading="lazy"
            fallback={<span className="tool-image-unavailable">Image no longer available</span>}
          />
        </button>
      )}
      <Reveal open={expanded}>
        <div className="tool-execution-detail">
          {shownSubject && (
            <div
              className={`rich-tool-subject ${workspaceRoot && ['read', 'diff', 'files'].includes(view) ? 'is-openable' : ''}`}
              onClick={() => {
                if (workspaceRoot && ['read', 'diff', 'files'].includes(view)) {
                  void window.api.workspace.openFile(shownSubject, workspaceRoot)
                }
              }}
              onContextMenu={(event) => {
                if (!workspaceRoot || !['read', 'diff', 'files'].includes(view)) return
                event.preventDefault()
                void window.api.workspace.showPathMenu(shownSubject, workspaceRoot)
              }}
            >
              <ExternalLink size={11} />
              {shownSubject}
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
              {commandResult ? (
                <CommandResultOutput
                  result={commandResult}
                  outputReference={tool.outputReference}
                  header={renderCommandHeader}
                />
              ) : output && view === 'terminal' ? (
                <div className="rich-tool-output is-terminal command-result">
                  {commandHeader ? (
                    renderCommandHeader(<CommandCopyButton text={output} />)
                  ) : (
                    <div className="command-result-bar">
                      <CommandCopyButton text={output} />
                    </div>
                  )}
                  <AnsiTerminalOutput value={bounded.text} />
                </div>
              ) : (
                commandHeader &&
                !commandLive && (
                  <div className="rich-tool-output is-terminal command-result">{commandHeader}</div>
                )
              )}
              {output && view !== 'terminal' && !previewUrl && (
                <div className={`rich-tool-output is-${view}`}>
                  <CommandCopyButton text={output} />
                  {numberedOutput ? (
                    <CodeExcerpt lines={numberedOutput} />
                  ) : (
                    <pre>{bounded.text}</pre>
                  )}
                </div>
              )}
              {!output && tool.data !== undefined && view === 'generic' && (
                <JsonTreeView value={tool.data} />
              )}
              {bounded.omitted > 0 && !numberedOutput && !commandResult && (
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
          {tool.outputReference?.truncated && !commandResult && (
            <div className="rich-tool-truncation">
              The agent was shown a shortened copy:{' '}
              {tool.outputReference.returnedBytes?.toLocaleString() ?? 'part'} of{' '}
              {tool.outputReference.originalBytes?.toLocaleString() ?? 'all the'} bytes. It can read
              the rest.
            </div>
          )}
        </div>
      </Reveal>
    </div>
  )
}
