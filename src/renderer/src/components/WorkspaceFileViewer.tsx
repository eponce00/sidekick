import { useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import {
  ArrowLeft,
  ExternalLink,
  FileCode2,
  FileText,
  Image as ImageIcon,
  Loader2
} from 'lucide-react'
import { MessageMarkdown } from './MessageMarkdown'
import type { WorkspaceFileViewRequest } from '../utils/workspaceFileViewer'
import './WorkspaceFileViewer.css'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
/** Extensions highlight.js does not name the way the file does. */
const LANGUAGE_ALIASES: Record<string, string> = {
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  jsx: 'javascript',
  tsx: 'typescript',
  yml: 'yaml',
  ps1: 'powershell',
  sh: 'bash',
  zsh: 'bash',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  rs: 'rust',
  kt: 'kotlin',
  py: 'python',
  rb: 'ruby',
  cs: 'csharp',
  toml: 'ini',
  env: 'ini',
  txt: 'plaintext',
  log: 'plaintext'
}

type ViewerState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'markdown'; content: string; totalLines: number }
  | { kind: 'code'; content: string; language: string | null; totalLines: number }

function extensionOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function languageFor(extension: string): string | null {
  const candidate = LANGUAGE_ALIASES[extension] ?? extension
  return candidate && hljs.getLanguage(candidate) ? candidate : null
}

export function WorkspaceFileViewer({
  request,
  onBack
}: {
  request: WorkspaceFileViewRequest
  onBack: () => void
}): React.JSX.Element {
  const [state, setState] = useState<ViewerState>({ kind: 'loading' })
  const targetLineRef = useRef<HTMLElement | null>(null)
  const extension = extensionOf(request.filePath)
  const fileName = request.filePath.split(/[\\/]/).pop() ?? request.filePath
  const directory = request.filePath.slice(0, request.filePath.length - fileName.length)

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    const load = async (): Promise<void> => {
      if (IMAGE_EXTENSIONS.has(extension)) {
        const result = await window.api.workspace.readImage(request.workspaceRoot, request.filePath)
        if (cancelled) return
        setState(
          result.ok && result.dataUrl
            ? { kind: 'image', dataUrl: result.dataUrl }
            : { kind: 'error', message: result.error || 'Could not read this image' }
        )
        return
      }
      const result = await window.api.workspace.readFile(request.workspaceRoot, request.filePath)
      if (cancelled) return
      if (!result.ok || result.content === null) {
        setState({ kind: 'error', message: result.error || 'Could not read this file' })
        return
      }
      const totalLines = result.totalLines ?? result.content.split('\n').length
      setState(
        MARKDOWN_EXTENSIONS.has(extension)
          ? { kind: 'markdown', content: result.content, totalLines }
          : { kind: 'code', content: result.content, language: languageFor(extension), totalLines }
      )
    }
    void load().catch((error: unknown) => {
      if (!cancelled) setState({ kind: 'error', message: String(error) })
    })
    return () => {
      cancelled = true
    }
  }, [extension, request.filePath, request.workspaceRoot])

  // Highlight once per content change; the result is an escaped HTML string
  // produced by highlight.js, so it is safe to inject.
  const highlighted = useMemo(() => {
    if (state.kind !== 'code') return null
    const lines = state.content.replace(/\n$/, '').split('\n')
    const html = state.language
      ? hljs.highlight(state.content, { language: state.language, ignoreIllegals: true }).value
      : hljs.highlightAuto(state.content).value
    return { html, lineCount: lines.length }
  }, [state])

  useEffect(() => {
    targetLineRef.current?.scrollIntoView({ block: 'center' })
  }, [highlighted, request.line])

  const shownLines =
    state.kind === 'code' || state.kind === 'markdown'
      ? state.content.replace(/\n$/, '').split('\n').length
      : 0
  const truncated =
    (state.kind === 'code' || state.kind === 'markdown') && state.totalLines > shownLines

  const Icon = IMAGE_EXTENSIONS.has(extension)
    ? ImageIcon
    : MARKDOWN_EXTENSIONS.has(extension)
      ? FileText
      : FileCode2

  return (
    <div className="workspace-file-viewer">
      <div className="workspace-file-viewer-header">
        <button
          type="button"
          className="workspace-file-viewer-back"
          onClick={onBack}
          aria-label="Back to file tree"
          title="Back to files"
        >
          <ArrowLeft size={14} />
        </button>
        <Icon className="workspace-file-viewer-icon" size={14} aria-hidden="true" />
        <span className="workspace-file-viewer-name" title={request.filePath}>
          {directory && <span className="workspace-file-viewer-dir">{directory}</span>}
          {fileName}
        </span>
        <button
          type="button"
          className="workspace-file-viewer-action"
          onClick={() =>
            void window.api.workspace.openFileReference(request.filePath, request.workspaceRoot)
          }
          onContextMenu={(event) => {
            event.preventDefault()
            void window.api.workspace.showPathMenu(request.filePath, request.workspaceRoot)
          }}
          aria-label="Open in external app"
          title="Open in external app · right-click for more"
        >
          <ExternalLink size={13} />
        </button>
      </div>

      <div className="workspace-file-viewer-body">
        {state.kind === 'loading' && (
          <div className="activity-empty">
            <Loader2 size={16} className="icon-spin" />
            <p>Loading…</p>
          </div>
        )}
        {state.kind === 'error' && (
          <div className="activity-empty">
            <p>{state.message}</p>
          </div>
        )}
        {state.kind === 'image' && (
          <div className="workspace-file-viewer-image">
            <img src={state.dataUrl} alt={fileName} />
          </div>
        )}
        {state.kind === 'markdown' && (
          <div className="workspace-file-viewer-markdown message-content">
            <MessageMarkdown content={state.content} workspaceRoot={request.workspaceRoot} />
          </div>
        )}
        {state.kind === 'code' && highlighted && (
          <pre className="workspace-file-viewer-code">
            <code className="hljs">
              {highlighted.html.split('\n').map((lineHtml, index) => {
                const lineNumber = index + 1
                const isTarget = request.line === lineNumber
                return (
                  <span
                    key={lineNumber}
                    ref={isTarget ? targetLineRef : undefined}
                    className={`workspace-file-viewer-line${isTarget ? ' is-target' : ''}`}
                  >
                    <span className="workspace-file-viewer-gutter" aria-hidden="true">
                      {lineNumber}
                    </span>
                    <span dangerouslySetInnerHTML={{ __html: lineHtml || ' ' }} />
                  </span>
                )
              })}
            </code>
          </pre>
        )}
        {truncated && (
          <div className="workspace-file-viewer-truncated">
            Showing the first {shownLines.toLocaleString()} of {state.totalLines.toLocaleString()}{' '}
            lines — open externally for the full file.
          </div>
        )}
      </div>
    </div>
  )
}
