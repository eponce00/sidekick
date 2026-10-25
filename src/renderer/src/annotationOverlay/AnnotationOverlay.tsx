import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Camera,
  Check,
  EyeOff,
  Eye,
  GripVertical,
  Mic,
  SlidersHorizontal,
  Trash2,
  X
} from 'lucide-react'
import type {
  AnnotationOverlayMessage,
  AnnotationOverlayState,
  AnnotationStyleValues
} from '../../../shared/annotationOverlay'
import { applyDictation, type DictationRange } from '../services/voice/dictationText'
import { StyleEditor } from './StyleEditor'
import { styleSummary } from './styleSummary'

declare global {
  interface Window {
    sidekickOverlay: {
      onState(callback: (state: AnnotationOverlayState) => void): () => void
      send(message: AnnotationOverlayMessage): void
    }
  }
}

const send = (message: AnnotationOverlayMessage): void => window.sidekickOverlay.send(message)

/** The bar's height and its gap from the top of the page, with room to spare. */
const BAR_CLEARANCE = 68

/** Where the note opens for a mark: below it when there is room, else above, inside the page. */
function notePlace(
  box: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number }
): { left: number; top: number; width: number } {
  const width = Math.min(380, Math.max(220, window.innerWidth - 24))
  const left = Math.min(Math.max(12, box.x), window.innerWidth - width - 12)
  const below = box.y + box.height + 10
  const top =
    below + size.height + 12 <= window.innerHeight
      ? below
      : Math.min(box.y - size.height - 10, window.innerHeight - size.height - 12)
  // Never under the bar at the top; a mark as large as the page gets its note inside it.
  return { left, top: Math.max(BAR_CLEARANCE, top), width }
}

/**
 * What the user sees over a page while marking it: each mark's outline and number, the element
 * under the pointer, the note for the mark being written, and a bar to picture, hide, clear, send
 * or stop. The page under it only ever sees the wheel, which the main process scrolls it with.
 */
export function AnnotationOverlay(): React.JSX.Element | null {
  const [state, setState] = useState<AnnotationOverlayState | null>(null)
  const [draft, setDraft] = useState('')
  const [barOffset, setBarOffset] = useState({ x: 0, y: 0 })
  const draftFor = useRef<string | null>(null)
  const noteRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [noteSize, setNoteSize] = useState({ width: 380, height: 52 })
  const pending = useRef<AnnotationOverlayMessage | null>(null)
  // What the style editor changed on the open mark, said in its note when it is kept.
  const [styled, setStyled] = useState<AnnotationStyleValues>({})
  // Where dictated words go in the note, and the last piece of text used.
  const dictationRange = useRef<DictationRange | null>(null)
  const heardSeq = useRef(0)

  useEffect(() => window.sidekickOverlay.onState(setState), [])

  useEffect(() => {
    if (!state) return
    // On the body, as the app sets its palette: the light theme's own accent is declared there.
    document.body.dataset.theme = state.theme
    document.body.style.setProperty('--accent', state.accent)
    document.body.style.setProperty('--on-accent', state.accentText)
  }, [state])

  // A note opened for another mark keeps what was typed in the last one.
  const editing = state?.marks.find((mark) => mark.id === state.editing)
  useEffect(() => {
    if (draftFor.current && draftFor.current !== editing?.id) {
      const previous = state?.marks.find((mark) => mark.id === draftFor.current)
      const kept = noteWithStyles(draft, styled)
      if (previous && kept !== previous.note.trim())
        send({ type: 'note', id: previous.id, note: kept })
    }
    if (draftFor.current !== (editing?.id ?? null)) {
      draftFor.current = editing?.id ?? null
      setDraft(editing?.note ?? '')
      setStyled({})
      dictationRange.current = null
    }
    // Only a change of mark matters here; the draft is read as it was.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id])

  // Dictated words go in at the caret, a phrase still being spoken replaced as it firms up.
  const heard = state?.dictation?.heard
  useEffect(() => {
    if (!heard || heard.seq === heardSeq.current) return
    heardSeq.current = heard.seq
    const input = inputRef.current
    setDraft((value) => {
      if (!dictationRange.current) {
        const caret = input?.selectionStart ?? value.length
        dictationRange.current = { start: caret, end: input?.selectionEnd ?? caret }
      }
      const next = applyDictation(value, dictationRange.current, heard.text, heard.final)
      dictationRange.current = next.range
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(next.caret, next.caret))
      return next.value.slice(0, 2000)
    })
  }, [heard])
  const listening = Boolean(state?.dictation?.listening)
  useEffect(() => {
    if (!state?.dictation) dictationRange.current = null
  }, [state?.dictation])

  const styleOpen = Boolean(editing && state?.style?.id === editing.id)
  useLayoutEffect(() => {
    const element = noteRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    if (Math.abs(rect.height - noteSize.height) > 1)
      setNoteSize({ width: rect.width, height: rect.height })
  }, [editing?.id, styleOpen, state?.style, noteSize.height])

  // Pointer moves are sent once a frame, the latest only.
  const sendSoon = (message: AnnotationOverlayMessage): void => {
    const first = !pending.current
    pending.current = message
    if (first)
      requestAnimationFrame(() => {
        if (pending.current) send(pending.current)
        pending.current = null
      })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      send({ type: 'stop' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!state) return null
  const saveNote = (): void => {
    if (!editing) return
    if (styleOpen) send({ type: 'styleDone', id: editing.id, keep: true })
    send({ type: 'note', id: editing.id, note: noteWithStyles(draft, styled) })
    draftFor.current = null
    send({ type: 'edit', id: null })
  }
  const place = editing ? notePlace(editing, noteSize) : null
  const count = state.marks.length

  return (
    <div className="ao-root">
      <div
        className="ao-surface"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          send({ type: 'pointer', kind: 'down', x: event.clientX, y: event.clientY })
        }}
        onPointerMove={(event) =>
          sendSoon({ type: 'pointer', kind: 'move', x: event.clientX, y: event.clientY })
        }
        onPointerUp={(event) => {
          if (event.button !== 0) return
          send({ type: 'pointer', kind: 'up', x: event.clientX, y: event.clientY })
        }}
        onPointerLeave={(event) => {
          if (event.buttons === 0) send({ type: 'pointer', kind: 'leave', x: 0, y: 0 })
        }}
        onWheel={(event) =>
          send({
            type: 'wheel',
            x: event.clientX,
            y: event.clientY,
            deltaX: event.deltaX,
            deltaY: event.deltaY
          })
        }
      />

      {!state.markersHidden &&
        state.marks.map((mark) => (
          <div
            key={mark.id}
            className={`ao-mark${mark.area ? ' is-area' : ''}${
              mark.id === state.editing ? ' is-editing' : ''
            }`}
            style={{ left: mark.x, top: mark.y, width: mark.width, height: mark.height }}
          >
            <button
              type="button"
              className="ao-badge"
              title={mark.note ? `${mark.name}: ${mark.note}` : mark.name}
              aria-label={`Mark ${mark.number}, ${mark.name}. Edit its note`}
              style={{
                left: Math.min(Math.max(4, mark.x - 11), window.innerWidth - 26) - mark.x,
                top: Math.min(Math.max(4, mark.y - 11), window.innerHeight - 26) - mark.y
              }}
              onClick={() => send({ type: 'edit', id: mark.id })}
            >
              {mark.number}
            </button>
          </div>
        ))}
      {state.drag && (
        <div
          className="ao-drag"
          style={{
            left: state.drag.x,
            top: state.drag.y,
            width: state.drag.width,
            height: state.drag.height
          }}
        />
      )}
      {state.hover && !state.drag && (
        <div
          className="ao-hover"
          style={{
            left: state.hover.x,
            top: state.hover.y,
            width: state.hover.width,
            height: state.hover.height
          }}
        >
          <span className={state.hover.y < 30 ? 'is-below' : undefined}>{state.hover.label}</span>
        </div>
      )}

      {editing && place && (
        <div
          ref={noteRef}
          className="ao-note-wrap"
          style={{ left: place.left, top: place.top, width: place.width }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="ao-note">
            <span className="ao-note-number" aria-hidden="true">
              {editing.number}
            </span>
            <input
              ref={inputRef}
              autoFocus
              value={draft}
              placeholder={listening ? 'Listening…' : 'Add a comment…'}
              aria-label={`Note for mark ${editing.number}, ${editing.name}`}
              maxLength={2000}
              onChange={(event) => {
                dictationRange.current = null
                setDraft(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  saveNote()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  if (styleOpen) send({ type: 'styleDone', id: editing.id, keep: false })
                  draftFor.current = null
                  send({ type: 'edit', id: null })
                }
              }}
            />
            {!editing.area && (
              <button
                type="button"
                className="ao-icon"
                aria-pressed={styleOpen}
                title={styleOpen ? 'Close the style editor' : 'Change its style, live on the page'}
                aria-label={styleOpen ? 'Close the style editor' : 'Change its style'}
                onClick={() =>
                  send(
                    styleOpen
                      ? { type: 'styleDone', id: editing.id, keep: true }
                      : { type: 'styleOpen', id: editing.id }
                  )
                }
              >
                <SlidersHorizontal size={15} />
              </button>
            )}
            {state.canDictate && (
              <button
                type="button"
                className={`ao-icon${listening ? ' is-listening' : ''}`}
                aria-pressed={listening}
                title={listening ? 'Stop dictating' : 'Dictate the note'}
                aria-label={listening ? 'Stop dictating' : 'Dictate the note'}
                onClick={() => {
                  dictationRange.current = null
                  send({ type: 'dictate', on: !listening })
                  inputRef.current?.focus()
                }}
              >
                <Mic size={15} />
              </button>
            )}
            <button
              type="button"
              className="ao-icon"
              title="Remove this mark"
              aria-label={`Remove mark ${editing.number}`}
              onClick={() => send({ type: 'remove', id: editing.id })}
            >
              <Trash2 size={15} />
            </button>
            <button
              type="button"
              className="ao-note-save"
              title="Keep this note (Enter)"
              aria-label="Keep this note"
              onClick={saveNote}
            >
              <Check size={16} strokeWidth={2.5} />
            </button>
          </div>
          {styleOpen && state.style && (
            <StyleEditor
              key={state.style.id}
              values={state.style.values}
              changed={styled}
              onChange={(styles) => {
                setStyled((current) => ({ ...current, ...styles }))
                send({ type: 'style', id: editing.id, styles })
              }}
              onReset={() => {
                setStyled({})
                send({ type: 'styleDone', id: editing.id, keep: false })
              }}
            />
          )}
        </div>
      )}

      <div
        className="ao-bar"
        role="toolbar"
        aria-label="Annotating"
        style={{ transform: `translate(calc(-50% + ${barOffset.x}px), ${barOffset.y}px)` }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span
          className="ao-grip"
          aria-hidden="true"
          onPointerDown={(event) => {
            const start = { x: event.clientX - barOffset.x, y: event.clientY - barOffset.y }
            const target = event.currentTarget
            target.setPointerCapture(event.pointerId)
            const move = (next: PointerEvent): void =>
              setBarOffset({ x: next.clientX - start.x, y: next.clientY - start.y })
            const end = (): void => {
              target.removeEventListener('pointermove', move)
              target.removeEventListener('pointerup', end)
            }
            target.addEventListener('pointermove', move)
            target.addEventListener('pointerup', end)
          }}
        >
          <GripVertical size={15} />
        </span>
        <span className="ao-bar-title">Annotating{count ? <span> · {count}</span> : null}</span>
        <button
          type="button"
          className="ao-icon"
          title="Take a screenshot of the page in view"
          aria-label="Take a screenshot"
          onClick={() => send({ type: 'screenshot' })}
        >
          <Camera size={16} />
        </button>
        <button
          type="button"
          className="ao-icon"
          disabled={!count}
          aria-pressed={state.markersHidden}
          title={state.markersHidden ? 'Show the marks' : 'Hide the marks'}
          aria-label={state.markersHidden ? 'Show the marks' : 'Hide the marks'}
          onClick={() => send({ type: 'markers', hidden: !state.markersHidden })}
        >
          {state.markersHidden ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>
        <button
          type="button"
          className="ao-icon"
          disabled={!count}
          title="Remove all marks"
          aria-label="Remove all marks"
          onClick={() => send({ type: 'clear' })}
        >
          <Trash2 size={16} />
        </button>
        <button
          type="button"
          className="ao-send"
          disabled={!count}
          onClick={() => {
            if (editing) saveNote()
            send({ type: 'send' })
          }}
        >
          Send
        </button>
        <button
          type="button"
          className="ao-icon"
          title="Stop annotating (Esc). Your marks stay until you send them."
          aria-label="Stop annotating"
          onClick={() => send({ type: 'stop' })}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}

/** The note as typed, with the style changes the user kept said after it. */
function noteWithStyles(draft: string, styled: AnnotationStyleValues): string {
  return [draft.trim(), styleSummary(styled)].filter(Boolean).join('\n').slice(0, 2000)
}
