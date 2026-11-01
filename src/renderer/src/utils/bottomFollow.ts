import { motionAllowed } from './messageMotion'

/**
 * Following the end of a scrolling view while its content grows, as a streaming reply does, and
 * letting go the moment the reader scrolls back to read.
 *
 * That the reader took over, or came back, is told from how the view moved, never from where it
 * is: content growing below, the view's own moves to the end, and rows above being measured change
 * that too, and "within so many pixels of the end" pulled a reader who scrolled up a little back
 * down with every chunk. Their input says so first where it can (the wheel, a scroll key, a held
 * pointer or touch), but input over an embedded frame reaches no listener here and only its chained
 * scroll arrives, so a scroll that the layout does not explain counts too. The rule is the one
 * use-stick-to-bottom, OpenCode and T3 Code follow.
 */

/** The view is at its end within this; fractional scroll offsets never quite reach it. */
export const AT_END_PX = 2
/** Scrolling down to within this of the end is back at it, whatever did the scrolling. */
const REACHED_END_PX = 8
/** The same with the scrollbar held or a key, whose target the growing end has moved on from. */
export const RESUME_FOLLOW_PX = 80
/** Content that moved further than this below the view glides there instead of jumping. */
const GLIDE_MIN_DISTANCE = 320
/** How quickly a glide closes the gap, and its least speed in px/ms, which outruns a stream. */
const GLIDE_MS = 90
const GLIDE_MIN_SPEED = 0.8
/** How long after a wheel, a key or a lifted finger the view's scrolling is still the reader's. */
const INPUT_SCROLL_MS = 600
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

export interface KeepAtEndOptions {
  /**
   * 'long' glides only over more than about half a screen, 'always' over any distance. Neither
   * glides further than two screens: that would only show rows streaming past.
   */
  glide?: 'never' | 'long' | 'always'
  /** Keep landing on the end this long, while rows below are still being measured. */
  settleMs?: number
  /**
   * Land at once, before paint: for a resize observer, which runs after layout, so the frame that
   * shows new content already shows the end. Otherwise the move waits for the next frame.
   */
  immediate?: boolean
}

const GLIDE_RANK = { never: 0, long: 1, always: 2 } as const

export interface BottomFollower {
  /** Whether the view keeps to its end as the content grows. */
  readonly following: boolean
  /** Follows the end again, as the reader asked; the next `keepAtEnd` moves there. */
  follow(): void
  /** Stops following, as when the view is moved back to an earlier message. */
  release(): void
  /** Brings a following view to its end from the next frame on, until it stays there. */
  keepAtEnd(options?: KeepAtEndOptions): void
  /** Leaves the view where it is for `ms`, as while a section the reader opened unfolds. */
  hold(ms: number): void
  /** Moves the view itself; unlike the reader scrolling there, this does not change `following`. */
  moveTo(top: number): void
  dispose(): void
}

export interface FollowOptions {
  /** With the scrollbar held or a key, moving down to within this of the end follows it again. */
  resumeWithin?: number
  /** Called when following starts or stops, after every scroll, and once the view is at its end. */
  onUpdate?: () => void
}

export function scrollDistanceFromBottom(
  element: Pick<Element, 'scrollHeight' | 'scrollTop' | 'clientHeight'>
): number {
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight)
}

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  )
}

/**
 * Whether a box inside `view`, under the wheel, scrolls first: a thinking box or tool output that
 * still has room that way, or one that never hands its scroll on to the view.
 */
function innerBoxTakes(target: EventTarget | null, view: Element, up: boolean): boolean {
  for (
    let node = target instanceof Element ? target : null;
    node && node !== view;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node)
    if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue
    if (node.scrollHeight <= node.clientHeight + 1) continue
    if (style.overscrollBehaviorY && style.overscrollBehaviorY !== 'auto') return true
    if (up ? node.scrollTop > 0 : scrollDistanceFromBottom(node) > AT_END_PX) return true
  }
  return false
}

export function followBottom(view: HTMLElement, options: FollowOptions = {}): BottomFollower {
  const resumeWithin = options.resumeWithin ?? RESUME_FOLLOW_PX
  const onUpdate = options.onUpdate ?? ((): void => undefined)
  let following = true
  let pointerHeld = false
  let onScrollbar = false
  let touchHeld = false
  /** When the wheel, a scroll key or a finger last moved the view, and which way they meant it. */
  let inputAt = Number.NEGATIVE_INFINITY
  let wheelDownAt = Number.NEGATIVE_INFINITY
  let keyDownAt = Number.NEGATIVE_INFINITY
  let swipeAt = Number.NEGATIVE_INFINITY
  let holdUntil = 0
  // Where the view and its layout were when last seen, to tell what moved it since.
  let lastTop = view.scrollTop
  let lastHeight = view.scrollHeight
  let lastClient = view.clientHeight

  // The move to the end runs one frame at a time, and every frame asks whether it still should.
  let frame: number | null = null
  let gliding = false
  let glide: NonNullable<KeepAtEndOptions['glide']> = 'never'
  let settleUntil = 0
  let settledFrames = 0
  let lastFrameAt: number | null = null

  const stopMoving = (): void => {
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
    gliding = false
    glide = 'never'
    settleUntil = 0
    lastFrameAt = null
  }

  const noteLayout = (): void => {
    lastTop = view.scrollTop
    lastHeight = view.scrollHeight
    lastClient = view.clientHeight
  }

  /** Whether following changed. */
  const setFollowing = (next: boolean): boolean => {
    if (following === next) return false
    following = next
    if (!next) stopMoving()
    return true
  }

  const step = (time: number): void => {
    frame = null
    if (!following || Date.now() < holdUntil) {
      stopMoving()
      return
    }
    const gap = scrollDistanceFromBottom(view)
    if (gap <= AT_END_PX) {
      noteLayout()
      gliding = false
      settledFrames += 1
      if (settledFrames >= 3 || Date.now() >= settleUntil) {
        stopMoving()
        onUpdate()
        return
      }
    } else {
      settledFrames = 0
      if (glide !== 'never') {
        gliding =
          gliding ||
          (gap <= view.clientHeight * 2 &&
            (glide === 'always' || gap > GLIDE_MIN_DISTANCE) &&
            motionAllowed())
        glide = 'never'
      }
      const elapsed =
        lastFrameAt === null || time <= lastFrameAt ? 16 : Math.min(64, time - lastFrameAt)
      const move = gliding
        ? Math.max(gap * (1 - Math.exp(-elapsed / GLIDE_MS)), elapsed * GLIDE_MIN_SPEED)
        : gap
      if (move >= gap) {
        const before = view.scrollTop
        view.scrollTop = view.scrollHeight
        gliding = false
        // A view that cannot move, such as a hidden one, would otherwise ask again every frame.
        if (view.scrollTop === before && Date.now() >= settleUntil) {
          stopMoving()
          return
        }
      } else {
        view.scrollTop += move
      }
      // The reader's next scroll is measured from here, even if its event and this move's arrive
      // as one.
      noteLayout()
    }
    lastFrameAt = time
    frame = window.requestAnimationFrame(step)
  }

  const onWheel = (event: WheelEvent): void => {
    // A pinch zooms, and a sideways scroll leaves the end where it is.
    if (event.ctrlKey || event.deltaY === 0) return
    inputAt = Date.now()
    const up = event.deltaY < 0
    wheelDownAt = up ? Number.NEGATIVE_INFINITY : inputAt
    if (up && following) {
      // Let go before the browser scrolls: a move to the end in between would cut the wheel off.
      if (view.scrollHeight <= view.clientHeight + AT_END_PX) return
      if (innerBoxTakes(event.target, view, true)) return
      if (setFollowing(false)) onUpdate()
    } else if (!up && !following) {
      // Back only if this wheel reaches the end, not for every nudge near it. At the very end it
      // scrolls nothing, so no scroll event would say so, and in a fast stream the end moves on
      // before the scroll lands.
      if (scrollDistanceFromBottom(view) - event.deltaY > REACHED_END_PX) return
      if (innerBoxTakes(event.target, view, false)) return
      if (setFollowing(true)) onUpdate()
    }
  }

  const onScroll = (): void => {
    const top = view.scrollTop
    const distance = scrollDistanceFromBottom(view)
    const movedUp = top < lastTop - 0.5
    const movedDown = top > lastTop + 0.5
    // Content shrinking under the view, or rows measured above it, move it too, and always change
    // the layout with it. A move with the layout as it was can only be the reader's.
    const relaidOut = view.scrollHeight !== lastHeight || view.clientHeight !== lastClient
    const shrank = view.scrollHeight < lastHeight
    // Slow scrolling moves less than a pixel per event; those moves add up against the same mark.
    const baseline = movedUp || movedDown ? top : lastTop
    noteLayout()
    lastTop = baseline
    const held = pointerHeld || touchHeld
    const now = Date.now()
    if (following) {
      // Dragging the scrollbar, selecting past the top, a swipe, or a scroll out of an embedded
      // frame.
      // Over a frame, a chunk landing at the same moment must not hide the move: growth cannot
      // explain a move up, and the next move to the end would cut the wheel off.
      const overFrame = !shrank && view.querySelector('iframe:hover') !== null
      if (movedUp && distance > AT_END_PX && (held || !relaidOut || overFrame)) setFollowing(false)
    } else if (movedDown) {
      const nearEnd =
        distance <= resumeWithin &&
        (held || now - keyDownAt < INPUT_SCROLL_MS || now - swipeAt < INPUT_SCROLL_MS)
      const atEnd =
        distance <= REACHED_END_PX && (!relaidOut || now - wheelDownAt < INPUT_SCROLL_MS)
      if (nearEnd || atEnd) setFollowing(true)
    }
    onUpdate()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isTextEntry(event.target) || !SCROLL_KEYS.has(event.key)) return
    // Keys scroll the view holding focus, or with focus on the page the one last clicked.
    if (view.clientHeight === 0) return
    if (event.target !== document.body && !view.contains(event.target as Node)) return
    inputAt = Date.now()
    const up =
      event.key === 'ArrowUp' ||
      event.key === 'PageUp' ||
      event.key === 'Home' ||
      (event.key === ' ' && event.shiftKey)
    keyDownAt = up ? Number.NEGATIVE_INFINITY : inputAt
    if (up && following) {
      // As with the wheel: a move to the end before the key's scroll starts would cut it off.
      if (view.scrollHeight <= view.clientHeight + AT_END_PX) return
      if (innerBoxTakes(event.target, view, true)) return
      if (setFollowing(false)) onUpdate()
    } else if (event.key === 'End' && !following) {
      // It asks for the end, and its smooth scroll lands where the end was when it started.
      if (setFollowing(true)) onUpdate()
    }
  }
  const onPointerDown = (event: PointerEvent): void => {
    // A touch is told by its own events: the browser cancels its pointer once it pans.
    if (event.pointerType !== 'touch') pointerHeld = true
    onScrollbar = pointerHeld && event.target === view && event.offsetX >= view.clientWidth
  }
  const onPointerUp = (event: Event): void => {
    // The thumb let go at the bottom of its track is all the way down, though in a stream the view
    // is still catching up with it and the end has moved on.
    const atTrackEnd =
      onScrollbar &&
      event.type === 'pointerup' &&
      (event as PointerEvent).clientY >= view.getBoundingClientRect().bottom - REACHED_END_PX
    pointerHeld = false
    onScrollbar = false
    if (atTrackEnd && setFollowing(true)) onUpdate()
  }
  const onPointerMove = (event: PointerEvent): void => {
    // A release over the scrollbar, or outside the window, may never arrive as a pointerup.
    if (pointerHeld && event.buttons === 0) onPointerUp(event)
  }
  const onTouchStart = (): void => {
    touchHeld = true
  }
  const onTouchEnd = (event: TouchEvent): void => {
    if (event.touches.length > 0) return
    touchHeld = false
    // A swipe glides on after the finger lifts.
    inputAt = Date.now()
    swipeAt = inputAt
  }
  const onSelectionChange = (): void => {
    // Selecting text to copy: following would move it from under the pointer.
    if (!following || !pointerHeld) return
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed || !view.contains(selection.anchorNode)) return
    if (setFollowing(false)) onUpdate()
  }

  view.addEventListener('wheel', onWheel, { passive: true })
  view.addEventListener('scroll', onScroll, { passive: true })
  view.addEventListener('pointerdown', onPointerDown)
  view.addEventListener('touchstart', onTouchStart, { passive: true })
  view.addEventListener('touchend', onTouchEnd)
  view.addEventListener('touchcancel', onTouchEnd)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('pointerup', onPointerUp, true)
  window.addEventListener('pointercancel', onPointerUp, true)
  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
  window.addEventListener('blur', onPointerUp)
  document.addEventListener('selectionchange', onSelectionChange)

  return {
    get following() {
      return following
    },
    follow() {
      holdUntil = 0
      if (setFollowing(true)) onUpdate()
    },
    release() {
      if (setFollowing(false)) onUpdate()
    },
    keepAtEnd(options = {}) {
      if (!following || Date.now() < holdUntil) return
      const requested = options.glide ?? 'never'
      if (GLIDE_RANK[requested] > GLIDE_RANK[glide]) glide = requested
      if (options.settleMs) settleUntil = Math.max(settleUntil, Date.now() + options.settleMs)
      // Growth that needs no glide lands at once when asked from a resize observer: waiting for
      // the next frame painted everything one frame lower first, a visible jolt as an artifact
      // grew. Not while the reader is scrolling, whose own scroll may not have arrived yet.
      const readerActive = pointerHeld || touchHeld || Date.now() - inputAt < INPUT_SCROLL_MS
      if (
        options.immediate &&
        !readerActive &&
        glide === 'never' &&
        !gliding &&
        scrollDistanceFromBottom(view) > AT_END_PX
      ) {
        view.scrollTop = view.scrollHeight
        noteLayout()
      }
      if (frame !== null) return
      settledFrames = 0
      lastFrameAt = null
      frame = window.requestAnimationFrame(step)
    },
    hold(ms) {
      holdUntil = Date.now() + ms
      stopMoving()
    },
    moveTo(top) {
      view.scrollTop = top
      noteLayout()
    },
    dispose() {
      stopMoving()
      view.removeEventListener('wheel', onWheel)
      view.removeEventListener('scroll', onScroll)
      view.removeEventListener('pointerdown', onPointerDown)
      view.removeEventListener('touchstart', onTouchStart)
      view.removeEventListener('touchend', onTouchEnd)
      view.removeEventListener('touchcancel', onTouchEnd)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('blur', onPointerUp)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }
}
