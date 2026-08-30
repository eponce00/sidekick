import type { ClipboardEvent, KeyboardEvent, ReactNode, RefObject } from 'react'
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
  onSend
}: ChatComposerProps): React.JSX.Element {
  const promptRefiner = usePromptRefinement({
    value,
    disabled,
    config: promptRefinement,
    onChange
  })
  const showPromptRefiner = promptRefiner.canRefine || promptRefiner.status !== 'idle'

  return (
    <div className={`input-area ${className}`.trim()}>
      {queueTray}
      <div
        className={`input-container ${showPromptRefiner ? 'has-prompt-sharpen' : ''} ${promptRefiner.status === 'success' || promptRefiner.status === 'error' ? 'has-prompt-sharpen-feedback' : ''}`.trim()}
        onClick={() => !disabled && inputRef.current?.focus()}
      >
        {floatingAccessory && (
          <div className="composer-floating-accessory">{floatingAccessory}</div>
        )}
        {popover && <div className="composer-popover">{popover}</div>}
        {contextBar && <div className="composer-context-bar">{contextBar}</div>}
        {attachmentTray}
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
            <div className="prompt-sharpen-feedback" aria-live="polite">
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

        <div className="input-toolbar">
          <div className="input-toolbar-left">{toolbarLeft}</div>
          <div className="input-toolbar-right">
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
  )
}
