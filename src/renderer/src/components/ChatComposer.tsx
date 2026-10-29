import { useEffect, useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode, RefObject } from 'react'
import TextareaAutosize from 'react-textarea-autosize'
import { ArrowUp } from 'lucide-react'
import type { PromptRefinementConfig } from '../services/providers/promptRefinement'
import { usePromptRefinement } from '../hooks/usePromptRefinement'
import { PromptSharpenIcon } from './PromptSharpenIcon'
import './ChatPanel.css'

interface ChatComposerProps {
  value: string
  inputRef: RefObject<HTMLTextAreaElement | null>
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  minRows?: number
  maxRows?: number
  className?: string
  toolbarLeft?: ReactNode
  toolbarRight?: ReactNode
  contextBar?: ReactNode
  queueTray?: ReactNode
  /** A status line under the composer card, such as the branch's pull request. */
  footer?: ReactNode
  popover?: ReactNode
  floatingAccessory?: ReactNode
  attachmentTray?: ReactNode
  inputAriaControls?: string
  inputAriaExpanded?: boolean
  inputAriaActiveDescendant?: string
  sendDisabled?: boolean
  sendTitle?: string
  sendButtonClassName?: string
  promptRefinement?: PromptRefinementConfig
  onChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  /** Files dropped on the box; without it, a drop does nothing. */
  onDropFiles?: (files: File[]) => void
  onSend: () => void
}

/** The shared composer surface used by direct and group conversations. */
export function ChatComposer({
  value,
  inputRef,
  placeholder = 'Type a message...',
  disabled = false,
  autoFocus = true,
  minRows = 2,
  maxRows = 10,
  className = '',
  toolbarLeft,
  toolbarRight,
  contextBar,
  queueTray,
  footer,
  popover,
  floatingAccessory,
  attachmentTray,
  inputAriaControls,
  inputAriaExpanded,
  inputAriaActiveDescendant,
  sendDisabled = false,
  sendTitle = 'Send message',
  sendButtonClassName = '',
  promptRefinement,
  onChange,
  onKeyDown,
  onPaste,
  onDropFiles,
  onSend
}: ChatComposerProps): React.JSX.Element {
  const promptRefiner = usePromptRefinement({
    value,
    disabled,
    config: promptRefinement,
    onChange
  })
  const showPromptRefiner = promptRefiner.canRefine || promptRefiner.status !== 'idle'
  const [dropping, setDropping] = useState(false)
  const carriesFiles = (event: DragEvent): boolean =>
    Boolean(onDropFiles) && !disabled && event.dataTransfer.types.includes('Files')
  // The autosizing textarea measures itself only when it renders or the window resizes. When the
  // chat narrows and widens again, as beside a full-size inspector, it would keep the height it
  // measured while narrow; a width change renders it again so it measures at the new width.
  const [, setMeasuredWidth] = useState(0)
  useEffect(() => {
    const element = inputRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      setMeasuredWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [inputRef])

  return (
    <div className={`input-area ${className}`.trim()}>
      {queueTray}
      {/* The jump button sits beside the box rather than in it, on a layer under it, so the box's
          opaque fill covers the part of the button's shadow that reaches below the button. */}
      <div className="composer-box">
        {floatingAccessory && (
          <div className="composer-floating-accessory">{floatingAccessory}</div>
        )}
        <div
          className={`input-container ${showPromptRefiner ? 'has-prompt-sharpen' : ''} ${dropping ? 'is-dropping' : ''}`.trim()}
          onClick={() => !disabled && inputRef.current?.focus()}
          onDragOver={(event) => {
            if (!carriesFiles(event)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
            setDropping(true)
          }}
          onDragLeave={(event) => {
            // Moving onto a child also leaves the box; only leaving it altogether ends the drop.
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDropping(false)
          }}
          onDrop={(event) => {
            setDropping(false)
            if (!carriesFiles(event)) return
            event.preventDefault()
            const files = Array.from(event.dataTransfer.files)
            if (files.length) onDropFiles?.(files)
            inputRef.current?.focus()
          }}
        >
          {popover && <div className="composer-popover">{popover}</div>}
          {contextBar && <div className="composer-context-bar">{contextBar}</div>}
          {attachmentTray}
          <div className="composer-input-row">
            <TextareaAutosize
              className="message-input"
              placeholder={placeholder}
              value={value}
              onChange={(event) => promptRefiner.handleChange(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              minRows={minRows}
              maxRows={maxRows}
              disabled={disabled}
              spellCheck
              ref={inputRef}
              tabIndex={0}
              autoFocus={autoFocus}
              aria-autocomplete={popover ? 'list' : undefined}
              aria-controls={inputAriaControls}
              aria-expanded={inputAriaExpanded}
              aria-activedescendant={inputAriaActiveDescendant}
            />

            {showPromptRefiner && (
              <div
                className={`prompt-sharpen-control is-${promptRefiner.status}`}
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="prompt-sharpen-button"
                  onClick={() => void promptRefiner.sharpen()}
                  disabled={!promptRefiner.canRefine || promptRefiner.status === 'refining'}
                  title={
                    promptRefiner.status === 'refining'
                      ? 'Sharpening prompt…'
                      : promptRefiner.status === 'error'
                        ? `${promptRefiner.error} Try again.`
                        : 'Sharpen prompt'
                  }
                  aria-label={
                    promptRefiner.status === 'refining' ? 'Sharpening prompt' : 'Sharpen prompt'
                  }
                >
                  <PromptSharpenIcon active={promptRefiner.status === 'refining'} />
                </button>
              </div>
            )}
          </div>

          <div className="input-toolbar">
            <div className="input-toolbar-left">{toolbarLeft}</div>
            <div className="input-toolbar-right">
              {/* The outcome of a sharpen is a status line, not something to wrap
                the prompt around, so it sits with the other composer status. */}
              <div
                className={`prompt-sharpen-feedback is-${promptRefiner.status}`}
                aria-live="polite"
                onClick={(event) => event.stopPropagation()}
              >
                {promptRefiner.status === 'success' && (
                  <>
                    <span>Prompt sharpened</span>
                    <span aria-hidden="true">·</span>
                    <button type="button" onClick={promptRefiner.undo}>
                      Undo
                    </button>
                  </>
                )}
                {promptRefiner.status === 'error' && (
                  <span title={promptRefiner.error}>Couldn’t sharpen</span>
                )}
              </div>
              {toolbarRight}
              <div className="input-buttons">
                <button
                  type="button"
                  className={`send-button ${sendButtonClassName}`.trim()}
                  onClick={onSend}
                  disabled={sendDisabled}
                  title={sendTitle}
                  aria-label="Send message"
                >
                  <ArrowUp size={17} strokeWidth={2.3} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      {footer}
    </div>
  )
}
