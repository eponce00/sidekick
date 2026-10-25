import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, Code2, Copy, Maximize2, Monitor, RotateCcw, X } from 'lucide-react'
import { useChatSurface } from '../chatSurface'
import type { ParsedArtifact } from '../../utils/artifactParser'
import { svgArtifactDocument } from '../../utils/htmlArtifactDocument'
import ArtifactFrame, { type ArtifactFrameStatus } from './ArtifactFrame'
import './Artifact.css'

type ArtifactResult = { title: string; success: boolean; error?: string; code?: string }

interface ArtifactProps {
  artifact: ParsedArtifact
  onResult?: (result: ArtifactResult) => void
}

const TYPE_LABELS: Record<ParsedArtifact['type'], string> = {
  react: 'React',
  html: 'HTML',
  svg: 'SVG'
}

/** What runs in the frame: SVG is shown as an HTML document of its own. */
function frameSource(artifact: ParsedArtifact): { kind: 'react' | 'html'; code: string } {
  if (artifact.type === 'react') return { kind: 'react', code: artifact.code }
  if (artifact.type === 'svg') return { kind: 'html', code: svgArtifactDocument(artifact.code) }
  return { kind: 'html', code: artifact.code }
}

function useCopyCode(code: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 1_600)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copy = useCallback(() => {
    void window.api.clipboard.writeText(code).then(
      (result) => {
        if (result.success) setCopied(true)
        else console.error('[Artifact] Could not copy code:', result.error)
      },
      (error) => console.error('[Artifact] Could not copy code:', error)
    )
  }, [code])
  return [copied, copy]
}

/** The artifact large, over the app, until Escape or Close. It runs anew there. */
function ArtifactFullScreen({
  artifact,
  onClose
}: {
  artifact: ParsedArtifact
  onClose: () => void
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const [copied, copy] = useCopyCode(artifact.code)
  const { kind, code } = frameSource(artifact)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus({ preventScroll: true })
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), iframe') || []
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      trigger?.focus({ preventScroll: true })
    }
  }, [onClose])

  return createPortal(
    <div
      ref={dialogRef}
      className="artifact-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label={artifact.title}
    >
      <div className="artifact-fullscreen-bar">
        <div className="artifact-fullscreen-title">
          <strong>{artifact.title}</strong>
          <span>{TYPE_LABELS[artifact.type]}</span>
        </div>
        <button
          type="button"
          className={`artifact-action${copied ? ' is-done' : ''}`}
          onClick={copy}
          aria-label={copied ? 'Code copied' : 'Copy code'}
          title={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button
          ref={closeRef}
          type="button"
          className="artifact-action"
          onClick={onClose}
          aria-label="Close full screen"
          title="Close (Esc)"
        >
          <X size={16} />
        </button>
      </div>
      <div className="artifact-fullscreen-body">
        <ArtifactFrame kind={kind} code={code} title={artifact.title} fill />
      </div>
    </div>,
    document.body
  )
}

/**
 * An artifact as part of the reply: no card around it, as wide as the text, as tall as its
 * content. Its name and its controls (code, copy, full screen) show beneath it on hover or focus.
 */
function ArtifactView({ artifact, onResult }: ArtifactProps): React.JSX.Element {
  const [attempt, setAttempt] = useState(0)
  const [failure, setFailure] = useState<{ error: string; visible: boolean } | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [fullScreen, setFullScreen] = useState(false)
  const [pointerInside, setPointerInside] = useState(false)
  const [copied, copy] = useCopyCode(artifact.code)
  const onResultRef = useRef(onResult)
  useEffect(() => {
    onResultRef.current = onResult
  })
  const { kind, code } = frameSource(artifact)
  const blocked = failure !== null && !failure.visible

  const handleStatus = useCallback(
    (status: ArtifactFrameStatus) => {
      if (status.status === 'rendered') {
        onResultRef.current?.({ title: artifact.title, success: true })
        return
      }
      // An error after the artifact showed leaves it in place, with a note; before, it replaces it.
      setFailure((current) =>
        current && !current.visible ? current : { error: status.error, visible: status.visible }
      )
      onResultRef.current?.({
        title: artifact.title,
        success: false,
        error: status.error,
        code: artifact.code
      })
    },
    [artifact.code, artifact.title]
  )

  const retry = (): void => {
    setFailure(null)
    setShowDetails(false)
    setAttempt((value) => value + 1)
  }

  // The frame says when the pointer leaves it, but a pointer that moves fast may leave without
  // the frame hearing; any of the chat's own elements under it means it is outside.
  useEffect(() => {
    if (!pointerInside) return undefined
    const onOver = (event: MouseEvent): void => {
      if (!(event.target instanceof HTMLIFrameElement)) setPointerInside(false)
    }
    document.addEventListener('mouseover', onOver)
    return () => document.removeEventListener('mouseover', onOver)
  }, [pointerInside])

  const closeFullScreen = useCallback(() => setFullScreen(false), [])
  const summary = failure?.error.split('\n')[0]

  return (
    <figure
      className={`artifact${showCode ? ' is-showing-code' : ''}${blocked ? ' is-failed' : ''}${
        pointerInside ? ' is-pointer-inside' : ''
      }`}
      data-artifact-type={artifact.type}
    >
      {blocked ? (
        <div className="artifact-failure" role="status">
          <button
            type="button"
            className="artifact-failure-summary"
            onClick={() => setShowDetails((value) => !value)}
            aria-expanded={showDetails}
          >
            <AlertTriangle size={14} aria-hidden="true" />
            <span className="artifact-failure-title">Couldn’t show {artifact.title}</span>
            {!showDetails && <span className="artifact-failure-reason">{summary}</span>}
          </button>
          <button type="button" className="artifact-text-button" onClick={retry}>
            <RotateCcw size={12} aria-hidden="true" />
            Retry
          </button>
          {showDetails && <pre className="artifact-failure-details">{failure.error}</pre>}
        </div>
      ) : (
        <div className="artifact-preview" hidden={showCode}>
          <ArtifactFrame
            key={attempt}
            kind={kind}
            code={code}
            title={artifact.title}
            onStatus={handleStatus}
            onPointer={setPointerInside}
          />
        </div>
      )}
      {showCode && (
        <pre className="artifact-code" aria-label={`${artifact.title} code`}>
          <code>{artifact.code}</code>
        </pre>
      )}
      {failure?.visible && !showCode && (
        <p className="artifact-note" role="status" title={failure.error}>
          <AlertTriangle size={12} aria-hidden="true" />
          <span>{summary}</span>
        </p>
      )}
      <figcaption className="artifact-caption">
        <span className="artifact-caption-name">
          <span className="artifact-caption-title">{artifact.title}</span>
          <span className="artifact-caption-type">{TYPE_LABELS[artifact.type]}</span>
        </span>
        <span className="artifact-actions">
          <button
            type="button"
            className={`artifact-action${showCode ? ' is-active' : ''}`}
            onClick={() => setShowCode((value) => !value)}
            aria-pressed={showCode}
            aria-label={showCode ? `Show ${artifact.title}` : 'View code'}
            title={showCode ? 'Show artifact' : 'View code'}
          >
            <Code2 size={14} />
          </button>
          <button
            type="button"
            className={`artifact-action${copied ? ' is-done' : ''}`}
            onClick={copy}
            aria-label={copied ? 'Code copied' : 'Copy code'}
            title={copied ? 'Copied' : 'Copy code'}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          {!blocked && (
            <button
              type="button"
              className="artifact-action"
              onClick={() => setFullScreen(true)}
              aria-label={`Open ${artifact.title} full screen`}
              title="Open full screen"
            >
              <Maximize2 size={14} />
            </button>
          )}
        </span>
      </figcaption>
      {fullScreen && <ArtifactFullScreen artifact={artifact} onClose={closeFullScreen} />}
    </figure>
  )
}

/** An artifact whose code is still arriving, from a reply that writes it inline. */
function ArtifactBuilding({ artifact }: { artifact: ParsedArtifact }): React.JSX.Element {
  return (
    <figure className="artifact is-building" data-artifact-type={artifact.type}>
      <div className="artifact-pending">
        <span className="artifact-pending-label">Building {artifact.title}</span>
      </div>
    </figure>
  )
}

/** Code still arriving after this long is unlikely to finish: run what has arrived. */
const STREAMING_TIMEOUT_MS = 10_000

function ArtifactInstance(props: ArtifactProps): React.JSX.Element {
  const { artifact, onResult } = props
  const [timedOut, setTimedOut] = useState(false)
  const streaming = Boolean(artifact.isStreaming) && !timedOut
  // Started once, when the code has begun to arrive; more code does not restart it.
  const arriving = Boolean(artifact.isStreaming) && artifact.code.length > 100
  const latest = useRef({ artifact, onResult })
  useEffect(() => {
    latest.current = { artifact, onResult }
  })

  useEffect(() => {
    if (!arriving) return undefined
    const timer = window.setTimeout(() => {
      setTimedOut(true)
      const { artifact: current, onResult: report } = latest.current
      report?.({
        title: current.title,
        success: false,
        error:
          'Artifact took too long to complete streaming. The closing </artifact> tag may be missing.',
        code: current.code
      })
    }, STREAMING_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [arriving])

  if (streaming) return <ArtifactBuilding artifact={artifact} />
  // New code is a new artifact: libraries such as Chart.js need a fresh document.
  return <ArtifactView key={artifact.code} {...props} />
}

/** An artifact where it cannot run, as on the phone: its name and where to open it. */
function ArtifactElsewhere({
  artifact,
  note
}: {
  artifact: ParsedArtifact
  note: string
}): React.JSX.Element {
  return (
    <figure className="artifact artifact-elsewhere" data-artifact-type={artifact.type}>
      <Monitor size={14} aria-hidden="true" />
      <span className="artifact-elsewhere-title">{artifact.title}</span>
      <span className="artifact-elsewhere-note">{note}</span>
    </figure>
  )
}

function Artifact(props: ArtifactProps): React.JSX.Element {
  const { computerOnly } = useChatSurface()
  if (computerOnly) return <ArtifactElsewhere artifact={props.artifact} note={computerOnly} />
  return <ArtifactInstance key={props.artifact.title} {...props} />
}

export default Artifact
