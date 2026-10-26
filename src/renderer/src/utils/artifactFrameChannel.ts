import {
  readArtifactHostCommand,
  type ArtifactFrameEvent,
  type ArtifactHostCommand
} from '../../../shared/artifactFrame'

// The frame's half of the artifact channel (see shared/artifactFrame.ts). The chat checks that a
// message came from this frame and from the artifact origin; the frame only takes commands from
// the window that embeds it, read through the same contract.

export function postToHost(event: ArtifactFrameEvent): void {
  // The chat's origin differs between development and the packaged app, and nothing sent here is
  // private: a size, a status, or an error message.
  window.parent.postMessage(event, '*')
}

export function listenToHost(onCommand: (command: ArtifactHostCommand) => void): () => void {
  const handle = (event: MessageEvent): void => {
    if (event.source !== window.parent) return
    const command = readArtifactHostCommand(event.data)
    if (command) onCommand(command)
  }
  window.addEventListener('message', handle)
  return () => window.removeEventListener('message', handle)
}

/** Reports uncaught errors, unless `when` says this frame keeps its errors to itself. */
export function reportErrorsToHost(when: () => boolean = () => true): () => void {
  const onError = (event: ErrorEvent): void => {
    if (when()) postToHost({ type: 'error', error: event.message || 'Uncaught error' })
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    if (!when()) return
    postToHost({
      type: 'error',
      error: event.reason instanceof Error ? event.reason.message : String(event.reason)
    })
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}

/** Tells the chat when the pointer enters and leaves this frame. */
export function reportPointerToHost(): () => void {
  let inside = false
  const set = (next: boolean): void => {
    if (next === inside) return
    inside = next
    postToHost({ type: 'pointer', inside })
  }
  const onOver = (): void => set(true)
  // Leaving the frame is a mouseout with nowhere inside it to go.
  const onOut = (event: MouseEvent): void => {
    if (!event.relatedTarget) set(false)
  }
  window.addEventListener('mouseover', onOver)
  window.addEventListener('mouseout', onOut)
  return () => {
    window.removeEventListener('mouseover', onOver)
    window.removeEventListener('mouseout', onOut)
  }
}

/**
 * How tall the content is, independent of how tall the frame is now. The document's scroll
 * height never drops below the frame's, so a frame sized by it could grow but never shrink; the
 * root element's own box and the body's overflow can.
 */
export function measureContentHeight(doc: Document): number {
  const rootHeight = doc.documentElement.getBoundingClientRect().height
  const bodyHeight = doc.body ? doc.body.scrollHeight : 0
  return Math.ceil(Math.max(rootHeight, bodyHeight))
}

/** Delay before a frame shorter than its content shows a scrollbar: the chat is resizing it. */
const SCROLLBAR_DELAY_MS = 300

/**
 * Reports the content's height whenever it changes. The chat sizes the frame to it, so the page
 * hides its scrollbar unless the content stays taller than the frame, as it does in a frame at
 * its height limit or in full screen.
 */
export function watchContentHeight(
  doc: Document,
  onHeight: (height: number) => void
): { measure: () => void; stop: () => void } {
  const view = doc.defaultView ?? window
  let last = -1
  let scrollbarTimer: number | undefined

  // Content that grows above what is in view, while the frame has not caught up yet, would
  // otherwise have the browser scroll the page to keep the view in place: the artifact jumps up
  // for a moment and back. Nothing scrolls a page without a scrollbar but the user.
  doc.documentElement.style.overflowAnchor = 'none'
  // Sideways too: with only the vertical axis set, the browser makes the other one scroll, and at
  // a fractional display scale content a fraction of a pixel wider than the frame got a scrollbar
  // over its last line. Only content genuinely wider than the frame scrolls sideways.
  const fitSideways = (): void => {
    const root = doc.documentElement
    root.style.overflowX = root.scrollWidth - root.clientWidth > 1 ? 'auto' : 'hidden'
  }
  // The room a sideways scrollbar takes, so the frame grows by it instead of covering content.
  const sidewaysBar = (): number => {
    const root = doc.documentElement
    return root.style.overflowX === 'auto' ? Math.max(0, view.innerHeight - root.clientHeight) : 0
  }
  const fitScrollbar = (): void => {
    view.clearTimeout(scrollbarTimer)
    fitSideways()
    const root = doc.documentElement
    if (root.style.overflowY !== 'auto') root.scrollTop = 0
    if (last <= view.innerHeight + 1) {
      root.style.overflowY = 'hidden'
      return
    }
    scrollbarTimer = view.setTimeout(() => {
      if (last > view.innerHeight + 1) root.style.overflowY = 'auto'
    }, SCROLLBAR_DELAY_MS)
  }

  // Measured right away rather than on the next animation frame: an offscreen inspection window
  // may never run one.
  const measure = (): void => {
    fitSideways()
    const height = measureContentHeight(doc) + sidewaysBar()
    if (height !== last) {
      last = height
      onHeight(height)
    }
    fitScrollbar()
  }

  const observer = new ResizeObserver(measure)
  observer.observe(doc.documentElement)
  if (doc.body) observer.observe(doc.body)
  // Images and fonts change the height when they arrive; load does not bubble, so capture it.
  doc.addEventListener('load', measure, true)
  view.addEventListener('resize', fitScrollbar)
  measure()

  return {
    measure,
    stop: () => {
      observer.disconnect()
      doc.removeEventListener('load', measure, true)
      view.removeEventListener('resize', fitScrollbar)
      view.clearTimeout(scrollbarTimer)
    }
  }
}
