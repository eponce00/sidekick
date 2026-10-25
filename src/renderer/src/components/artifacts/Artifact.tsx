import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Loader2,
  Maximize2,
  Monitor,
  RotateCcw,
  X
} from 'lucide-react'
import { useChatSurface } from '../chatSurface'
import { useSubAgentRun } from '../../hooks/useSubAgentRun'
import { useArtifactDraft } from '../../services/artifactDrafts'
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

/** What a live artifact is doing, said beneath it until it is finished. */
type ArtifactPhase = 'writing' | 'checking' | 'refining'

const PHASE_LABELS: Record<ArtifactPhase, string> = {
  writing: 'Writing',
  checking: 'Checking how it looks',
  refining: 'Polishing'
}

/** A version replacing one that shows waits at least this long after it runs... */
const SETTLE_MIN_MS = 1_200
/** ...and until its layout has not changed for this long... */
const SETTLE_QUIET_MS = 500
/** ...but no longer than this. */
const SETTLE_MAX_MS = 4_000

/** One frame in the artifact's place: a draft (`code` null) or a version of it that runs. */
interface FrameSlot {
  key: number
  code: string | null
  /** It replaced something already showing, so it appears without its charts animating in. */
  still?: boolean
}

type FrameLayer = 'current' | 'incoming' | 'leaving'

interface ArtifactViewProps {
  artifact: ParsedArtifact
  /** The code so far while it is written, or null. */
  draftCode: string | null
  /** The version to show: the latest that is complete, or null while there is none. */
  code: string | null
  phase: ArtifactPhase | null
  onResult?: (result: ArtifactResult) => void
}

/**
 * An artifact as part of the reply: no card around it, as wide as the text, as tall as its
 * content. It takes shape in place while it is written; each later version loads behind the one
 * showing and replaces it once it runs, so a version that fails, or the moment between two, is
 * never seen. Its name and controls (code, copy, full screen) show beneath it on hover or focus.
 */
function ArtifactView({
  artifact,
  draftCode,
  code,
  phase,
  onResult
}: ArtifactViewProps): React.JSX.Element {
  const nextKey = useRef(1)
  // Versions that failed here, with why: not loaded again, and shown as the failure if one of
  // them is still the version when the call finishes.
  const failures = useRef(new Map<string, { error: string; visible: boolean }>())
  // A draft frame keeps showing the last code that arrived until a complete version replaces it.
  const [lastDraft, setLastDraft] = useState('')
  if (draftCode !== null && draftCode !== lastDraft) setLastDraft(draftCode)
  const [current, setCurrent] = useState<FrameSlot | null>(() =>
    code !== null ? { key: 0, code } : draftCode !== null ? { key: 0, code: null } : null
  )
  const [incoming, setIncoming] = useState<FrameSlot | null>(null)
  const [leaving, setLeaving] = useState<FrameSlot | null>(null)
  const [incomingReady, setIncomingReady] = useState(false)
  const incomingReadyAt = useRef(0)
  const incomingChangedAt = useRef(0)
  const [height, setHeight] = useState<number | null>(null)
  const [failure, setFailure] = useState<{ error: string; visible: boolean } | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [fullScreen, setFullScreen] = useState(false)
  const [pointerInside, setPointerInside] = useState(false)
  const onResultRef = useRef(onResult)
  useEffect(() => {
    onResultRef.current = onResult
  })
  const shownCode = current?.code ?? draftCode ?? code ?? ''
  const [copied, copy] = useCopyCode(shownCode)
  const kind = frameSource({ ...artifact, code: '' }).kind
  const source = (value: string): string => frameSource({ ...artifact, code: value }).code
  const blocked = failure !== null && !failure.visible

  // A draft starts the moment its first code arrives; a complete version loads behind what shows.
  useEffect(() => {
    if (current === null) {
      if (code !== null) setCurrent({ key: nextKey.current++, code })
      else if (draftCode !== null) setCurrent({ key: nextKey.current++, code: null })
      return
    }
    if (code === null || code === current.code || code === incoming?.code) return
    if (failures.current.has(code)) return
    setIncoming({ key: nextKey.current++, code, still: true })
  }, [code, current, draftCode, incoming?.code])

  // A call can finish on a version that failed while it was reviewed, when no fix ran.
  useEffect(() => {
    if (phase !== null || code === null || failure) return
    const failed = failures.current.get(code)
    if (!failed) return
    setFailure(current?.code === code ? failed : { error: failed.error, visible: false })
    onResultRef.current?.({ title: artifact.title, success: false, error: failed.error, code })
  }, [artifact.title, code, current?.code, failure, phase])

  // What it replaced fades out over what replaced it, then goes.
  useEffect(() => {
    if (!leaving) return undefined
    const timer = window.setTimeout(() => setLeaving(null), 320)
    return () => window.clearTimeout(timer)
  }, [leaving])

  const report = useCallback(
    (frameCode: string, status: ArtifactFrameStatus, final: boolean) => {
      if (!final) return
      onResultRef.current?.(
        status.status === 'rendered'
          ? { title: artifact.title, success: true }
          : { title: artifact.title, success: false, error: status.error, code: frameCode }
      )
    },
    [artifact.title]
  )

  const handleCurrentStatus = (slot: FrameSlot, status: ArtifactFrameStatus): void => {
    if (slot.code === null) return
    report(slot.code, status, phase === null)
    if (status.status === 'rendered') return
    failures.current.set(slot.code, { error: status.error, visible: status.visible })
    // A version still being reviewed may fail; the review replaces it. A finished one that fails
    // before it shows replaces itself with the failure, and after, keeps a note beneath it.
    if (phase !== null && !status.visible) return
    setFailure((existing) =>
      existing && !existing.visible ? existing : { error: status.error, visible: status.visible }
    )
  }

  const promote = useCallback(
    (slot: FrameSlot) => {
      setLeaving(current)
      setCurrent(slot)
      setIncoming(null)
      setIncomingReady(false)
      setFailure(null)
    },
    [current]
  )

  // Over something already showing, a new version takes its place only once it has settled out of
  // sight: its charts have drawn and its layout has stopped changing, so the change is the content,
  // never a version still animating in.
  useEffect(() => {
    if (!incomingReady || !incoming) return undefined
    const timer = window.setInterval(() => {
      const now = Date.now()
      const ready = now - incomingReadyAt.current
      const settled = ready >= SETTLE_MIN_MS && now - incomingChangedAt.current >= SETTLE_QUIET_MS
      if (settled || ready >= SETTLE_MAX_MS) promote(incoming)
    }, 100)
    return () => window.clearInterval(timer)
  }, [incoming, incomingReady, promote])

  const handleIncomingStatus = (slot: FrameSlot, status: ArtifactFrameStatus): void => {
    if (slot.code === null) return
    report(slot.code, status, phase === null)
    if (status.status === 'rendered') {
      if (current && !blocked) {
        incomingReadyAt.current = Date.now()
        setIncomingReady(true)
      } else promote(slot)
      return
    }
    failures.current.set(slot.code, { error: status.error, visible: false })
    setIncoming(null)
    // While it is reviewed, a version that fails waits for the next one; the one showing stays.
    // A finished version that fails shows its failure only where nothing ran before it.
    if (phase === null && (current?.code === null || current === null)) {
      setFailure({ error: status.error, visible: false })
    }
  }

  const retry = (): void => {
    setFailure(null)
    setShowDetails(false)
    const latest = incoming?.code ?? code ?? current?.code
    failures.current.clear()
    setIncoming(null)
    if (latest) setCurrent({ key: nextKey.current++, code: latest, still: true })
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
  const title = artifact.title || 'artifact'

  const frame = (slot: FrameSlot, layer: FrameLayer): React.JSX.Element => (
    <div key={slot.key} className={`artifact-layer is-${layer}`} aria-hidden={layer !== 'current'}>
      <ArtifactFrame
        kind={kind}
        code={source(slot.code ?? lastDraft)}
        title={title}
        draft={slot.code === null}
        still={slot.still}
        pendingLabel={slot.code === null ? `Writing ${title}` : `Rendering ${title}`}
        onStatus={
          layer === 'current'
            ? (status) => handleCurrentStatus(slot, status)
            : layer === 'incoming'
              ? (status) => handleIncomingStatus(slot, status)
              : undefined
        }
        onPointer={layer === 'current' ? setPointerInside : undefined}
        onHeight={
          layer === 'current'
            ? setHeight
            : layer === 'incoming'
              ? () => {
                  incomingChangedAt.current = Date.now()
                }
              : undefined
        }
      />
    </div>
  )

  return (
    <figure
      className={`artifact${showCode ? ' is-showing-code' : ''}${blocked ? ' is-failed' : ''}${
        pointerInside ? ' is-pointer-inside' : ''
      }${phase ? ` is-${phase}` : ''}`}
      data-artifact-type={artifact.type}
      aria-busy={phase !== null}
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
            <span className="artifact-failure-title">Couldn’t show {title}</span>
            {!showDetails && <span className="artifact-failure-reason">{summary}</span>}
          </button>
          <button type="button" className="artifact-text-button" onClick={retry}>
            <RotateCcw size={12} aria-hidden="true" />
            Retry
          </button>
          {showDetails && <pre className="artifact-failure-details">{failure.error}</pre>}
        </div>
      ) : current ? (
        <div
          className="artifact-preview"
          hidden={showCode}
          // Held at the showing version's height only while two versions cross; otherwise it is as
          // tall as its frame, the moment the frame grows.
          style={height === null || !leaving ? undefined : { height }}
        >
          {/* In the order they were made: a frame moved within the page would load again. */}
          {(
            [
              [current, 'current'],
              [leaving, 'leaving'],
              [incoming, 'incoming']
            ] as const
          )
            .filter((entry): entry is readonly [FrameSlot, FrameLayer] => entry[0] !== null)
            .sort(([a], [b]) => a.key - b.key)
            .map(([slot, layer]) => frame(slot, layer))}
        </div>
      ) : (
        <div className="artifact-pending is-alone" aria-hidden="true">
          <span className="artifact-pending-label">Writing {title}</span>
        </div>
      )}
      {showCode && (
        <pre className="artifact-code" aria-label={`${title} code`}>
          <code>{shownCode}</code>
        </pre>
      )}
      {phase && current && !blocked && (
        <p className="artifact-status" role="status">
          <Loader2 size={12} className="icon-spin" aria-hidden="true" />
          <span>{PHASE_LABELS[phase]}</span>
        </p>
      )}
      {failure?.visible && !showCode && !phase && (
        <p className="artifact-note" role="status" title={failure.error}>
          <AlertTriangle size={12} aria-hidden="true" />
          <span>{summary}</span>
        </p>
      )}
      <figcaption className="artifact-caption">
        <span className="artifact-caption-name">
          <span className="artifact-caption-title">{title}</span>
          <span className="artifact-caption-type">{TYPE_LABELS[artifact.type]}</span>
        </span>
        <span className="artifact-actions">
          <button
            type="button"
            className={`artifact-action${showCode ? ' is-active' : ''}`}
            onClick={() => setShowCode((value) => !value)}
            aria-pressed={showCode}
            aria-label={showCode ? `Show ${title}` : 'View code'}
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
          {!blocked && current?.code && (
            <button
              type="button"
              className="artifact-action"
              onClick={() => setFullScreen(true)}
              aria-label={`Open ${title} full screen`}
              title="Open full screen"
            >
              <Maximize2 size={14} />
            </button>
          )}
        </span>
      </figcaption>
      {fullScreen && current?.code && (
        <ArtifactFullScreen
          artifact={{ ...artifact, code: current.code }}
          onClose={closeFullScreen}
        />
      )}
    </figure>
  )
}

/**
 * The latest version an artifact's builder made that ran, and whether it is making another.
 * Followed only while the builder works; the finished call carries the version it chose.
 */
function useBuilderVersion(childRunId: string | undefined): {
  code: string | null
  refining: boolean
} {
  const { snapshot } = useSubAgentRun(childRunId ?? null, Boolean(childRunId))
  return useMemo(() => {
    let code: string | null = null
    let refining = false
    for (const segment of snapshot.projection.segments) {
      if (segment.type !== 'tool') continue
      if (segment.tool.name !== 'create_artifact' && segment.tool.name !== 'edit_artifact') continue
      const { status, data } = segment.tool
      if (status === 'pending' || status === 'running') refining = true
      else if (status === 'success') {
        const built = (data as { artifact?: { code?: unknown } } | undefined)?.artifact?.code
        if (typeof built === 'string') code = built
      }
    }
    return { code, refining }
  }, [snapshot])
}

function ArtifactInstance({ artifact, onResult }: ArtifactProps): React.JSX.Element {
  const live = Boolean(artifact.isStreaming)
  const fromCall = Boolean(artifact.toolCallId)
  // A call streams its code apart from the reply; an artifact written in the reply's text is its
  // own draft until its closing tag arrives.
  const streamed = useArtifactDraft(
    live && fromCall && !artifact.code ? artifact.toolCallId : undefined
  )
  const builder = useBuilderVersion(live && fromCall ? artifact.childRunId : undefined)
  const draftCode = !live ? null : fromCall ? (artifact.code ? null : streamed) : artifact.code
  const code = !live ? artifact.code : fromCall ? (builder.code ?? (artifact.code || null)) : null
  const phase: ArtifactPhase | null = !live
    ? null
    : !fromCall || !artifact.code
      ? 'writing'
      : builder.refining
        ? 'refining'
        : 'checking'
  return (
    <ArtifactView
      artifact={artifact}
      draftCode={draftCode}
      code={code}
      phase={phase}
      onResult={onResult}
    />
  )
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
  // Keyed by its call, so it stays one artifact from its first code to its finished version.
  return <ArtifactInstance key={props.artifact.toolCallId ?? props.artifact.title} {...props} />
}

export default Artifact
