import React, { useEffect, useRef, useState } from 'react'
import {
  ARTIFACT_HTML_SANDBOX_URL,
  ARTIFACT_ORIGIN,
  ARTIFACT_REACT_SANDBOX_URL,
  readArtifactFrameEvent,
  type ArtifactHostCommand
} from '../../../../shared/artifactFrame'
import {
  boundedArtifactFrameHeight,
  MAX_ARTIFACT_FRAME_HEIGHT,
  PENDING_ARTIFACT_FRAME_HEIGHT,
  rememberArtifactHeight,
  rememberedArtifactHeight
} from '../../utils/artifactFrameSize'
import { getArtifactTheme, observeArtifactTheme } from '../../utils/artifactTheme'

export type ArtifactFrameKind = 'react' | 'html'

export type ArtifactFrameStatus =
  | { status: 'rendered' }
  /** `visible` when the artifact was already showing, so it stays and the error is a note. */
  | { status: 'failed'; error: string; visible: boolean }

const RENDER_TIMEOUT_MS = 15_000

interface ArtifactFrameProps {
  kind: ArtifactFrameKind
  code: string
  title: string
  /** Fill the space it is given and scroll inside, as in full screen, instead of growing. */
  fill?: boolean
  maxHeight?: number
  /**
   * The code is still arriving: the frame shows as much of it as runs, updating in place as more
   * comes, and reports no status. The finished code runs in a frame of its own.
   */
  draft?: boolean
  /** It replaces what the user already sees, so its charts appear drawn rather than drawn in. */
  still?: boolean
  /** The quiet line in its place before it first shows. */
  pendingLabel?: string
  onStatus?: (status: ArtifactFrameStatus) => void
  /** The height it takes in the reply, as it changes. */
  onHeight?: (height: number) => void
  /** The pointer entered or left the artifact, which the page cannot see for itself. */
  onPointer?: (inside: boolean) => void
}

/**
 * Runs one artifact in a sandbox on the artifact origin and sizes it to its content. Before the
 * artifact first shows, the frame holds one quiet line; then it grows to the content's height and
 * follows it as the content changes, up to `maxHeight`.
 */
function ArtifactFrame({
  kind,
  code,
  title,
  fill = false,
  maxHeight = MAX_ARTIFACT_FRAME_HEIGHT,
  draft = false,
  still = false,
  pendingLabel = `Rendering ${title}`,
  onStatus,
  onPointer,
  onHeight
}: ArtifactFrameProps): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const readyRef = useRef(false)
  const settledRef = useRef<'pending' | 'rendered' | 'failed'>('pending')
  const shownRef = useRef(false)
  const errorsRef = useRef(new Set<string>())
  const onStatusRef = useRef(onStatus)
  const onPointerRef = useRef(onPointer)
  const codeRef = useRef(code)
  useEffect(() => {
    onStatusRef.current = onStatus
    onPointerRef.current = onPointer
    codeRef.current = code
  })
  // A draft frame lives for the whole draft; only a finished artifact's code starts anew.
  const runCode = draft ? null : code
  const [contentHeight, setContentHeight] = useState<number | null>(() =>
    rememberedArtifactHeight(kind, code)
  )
  // An artifact shown before holds the height it had from the start.
  const [heldBefore] = useState(() => contentHeight !== null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const send = (command: ArtifactHostCommand): void => {
      // Addressed to the artifact origin, so the code never reaches a frame that navigated away.
      iframeRef.current?.contentWindow?.postMessage(command, ARTIFACT_ORIGIN)
    }
    const show = (): void => {
      if (shownRef.current) return
      shownRef.current = true
      setShown(true)
    }
    const handle = (event: MessageEvent): void => {
      const frame = iframeRef.current
      if (!frame || event.source !== frame.contentWindow || event.origin !== ARTIFACT_ORIGIN) return
      const message = readArtifactFrameEvent(event.data)
      if (!message) return
      switch (message.type) {
        case 'ready':
          readyRef.current = true
          send(
            draft
              ? { type: 'draft', code: codeRef.current, theme: getArtifactTheme() }
              : { type: 'render', code: codeRef.current, theme: getArtifactTheme(), still }
          )
          break
        case 'resize': {
          // Sized here and now, not on React's next render: the frame's page has already drawn
          // its new layout, and until the chat makes room the growth pushes the reply down.
          const frame = iframeRef.current
          if (frame && !fill && shownRef.current && message.height > 0) {
            const height = `${boundedArtifactFrameHeight(message.height, maxHeight)}px`
            frame.style.height = height
            if (frame.parentElement) frame.parentElement.style.height = height
          }
          setContentHeight(message.height)
          if (message.height > 0 && !draft) rememberArtifactHeight(kind, code, message.height)
          if (message.height > 0 && settledRef.current !== 'failed') show()
          break
        }
        case 'pointer':
          onPointerRef.current?.(message.inside)
          break
        case 'success':
          if (settledRef.current !== 'pending') break
          settledRef.current = 'rendered'
          show()
          onStatusRef.current?.({ status: 'rendered' })
          break
        case 'error': {
          if (errorsRef.current.has(message.error)) break
          errorsRef.current.add(message.error)
          const visible = shownRef.current
          if (settledRef.current === 'pending') settledRef.current = 'failed'
          onStatusRef.current?.({ status: 'failed', error: message.error, visible })
          break
        }
      }
    }
    window.addEventListener('message', handle)
    const stopTheme = observeArtifactTheme((theme) => {
      if (readyRef.current) send({ type: 'theme', theme })
    })
    const timeout = window.setTimeout(() => {
      if (draft || settledRef.current !== 'pending') return
      settledRef.current = 'failed'
      onStatusRef.current?.({
        status: 'failed',
        error: `The artifact did not finish rendering within ${RENDER_TIMEOUT_MS / 1000} seconds.`,
        visible: shownRef.current
      })
    }, RENDER_TIMEOUT_MS)
    return () => {
      window.removeEventListener('message', handle)
      onPointerRef.current?.(false)
      stopTheme()
      window.clearTimeout(timeout)
    }
    // runCode stands for code: a draft's code changes without starting the frame again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // fill and maxHeight are fixed for a frame's life.
  }, [runCode, kind, draft, still])

  useEffect(() => {
    if (draft && readyRef.current) {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'draft', code, theme: getArtifactTheme() },
        ARTIFACT_ORIGIN
      )
    }
  }, [code, draft])

  const frameHeight =
    contentHeight === null
      ? PENDING_ARTIFACT_FRAME_HEIGHT
      : boundedArtifactFrameHeight(contentHeight, maxHeight)
  const stageHeight = shown || heldBefore ? frameHeight : PENDING_ARTIFACT_FRAME_HEIGHT
  useEffect(() => {
    if (!fill) onHeight?.(stageHeight)
  }, [fill, onHeight, stageHeight])

  return (
    <div
      className={`artifact-stage${shown ? ' is-shown' : ''}${fill ? ' is-fill' : ''}`}
      style={fill ? undefined : { height: stageHeight }}
      data-content-height={contentHeight ?? undefined}
    >
      <iframe
        ref={iframeRef}
        className="artifact-frame"
        src={kind === 'react' ? ARTIFACT_REACT_SANDBOX_URL : ARTIFACT_HTML_SANDBOX_URL}
        sandbox="allow-scripts allow-same-origin"
        title={title}
        style={fill ? undefined : { height: frameHeight }}
      />
      {!shown && (
        <div className="artifact-pending" aria-hidden="true">
          <span className="artifact-pending-label">{pendingLabel}</span>
        </div>
      )}
    </div>
  )
}

export default ArtifactFrame
