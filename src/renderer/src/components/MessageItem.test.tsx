// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageItem } from './MessageItem'
import ToolCallRow from './ToolCallRow'

describe('MessageItem shared-channel presentation', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('uses the normal hover action surface while preserving sender context', async () => {
    const copyMessage = vi.fn()
    const editMessage = vi.fn()
    const retryMessage = vi.fn()
    await act(async () => {
      root.render(
        <MessageItem
          message={{
            id: 'message',
            role: 'user',
            senderLabel: 'You',
            senderContext: 'to Data agent',
            content: 'Run the analysis',
            timestamp: Date.now()
          }}
          index={0}
          isLoading={false}
          expandedThinking={new Set()}
          editingMessageId={null}
          editingGeometry={null}
          editingContent=""
          copiedMessageId={null}
          onToggleThinking={vi.fn()}
          onHandleArtifactResult={vi.fn()}
          onEditMessage={editMessage}
          onCancelEditMessage={vi.fn()}
          onConfirmEditMessage={vi.fn()}
          onCopyMessage={copyMessage}
          onRetryMessage={retryMessage}
          onSetEditingContent={vi.fn()}
          onApproveToolLimitDecision={vi.fn()}
          onDenyToolLimitDecision={vi.fn()}
          editActionTitle="Edit and resend"
          retryActionTitle="Send again"
        />
      )
    })

    expect(container.querySelector('.message-sender')?.textContent).toContain('You')
    expect(container.querySelector('.message-sender')?.textContent).toContain('to Data agent')
    expect(container.querySelector('[aria-label="Copy message"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Edit and resend"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Send again"]')).not.toBeNull()

    const copyButton = container.querySelector('[aria-label="Copy message"]') as HTMLButtonElement
    const editButton = container.querySelector(
      '[aria-label="Edit and resend"]'
    ) as HTMLButtonElement
    const retryButton = container.querySelector('[aria-label="Send again"]') as HTMLButtonElement
    await act(async () => {
      copyButton.click()
      editButton.click()
      retryButton.click()
    })
    expect(copyMessage).toHaveBeenCalledOnce()
    expect(editMessage).toHaveBeenCalledOnce()
    expect(retryMessage).toHaveBeenCalledOnce()
  })

  it('keeps an edited message anchored, full-sized, and focused', async () => {
    container.className = 'messages-container'
    container.scrollTop = 420
    await act(async () => {
      root.render(
        <MessageItem
          message={{
            id: 'editing-message',
            role: 'user',
            content: 'A longer message that should keep its visual footprint while being edited.',
            timestamp: Date.now()
          }}
          index={0}
          isLoading={false}
          expandedThinking={new Set()}
          editingMessageId="editing-message"
          editingGeometry={{ width: 640, height: 132, viewportTop: 0 }}
          editingContent="A longer message that should keep its visual footprint while being edited."
          copiedMessageId={null}
          onToggleThinking={vi.fn()}
          onHandleArtifactResult={vi.fn()}
          onEditMessage={vi.fn()}
          onCancelEditMessage={vi.fn()}
          onConfirmEditMessage={vi.fn()}
          onCopyMessage={vi.fn()}
          onRetryMessage={vi.fn()}
          onSetEditingContent={vi.fn()}
          onApproveToolLimitDecision={vi.fn()}
          onDenyToolLimitDecision={vi.fn()}
          confirmEditActionTitle="Save and restart from here"
        />
      )
    })

    const bubble = container.querySelector('.message-bubble') as HTMLDivElement
    const input = container.querySelector('.message-edit-input') as HTMLTextAreaElement
    expect(bubble.style.width).toBe('640px')
    expect(bubble.style.minHeight).toBe('132px')
    expect(input.style.height).toBe('24px')
    expect(document.activeElement).toBe(input)
    expect(container.scrollTop).toBe(420)
    expect(container.querySelector('[aria-label="Save and restart from here"]')).not.toBeNull()
  })

  it('keeps compact tool status hints available even when a row has no click action', async () => {
    await act(async () => {
      root.render(
        <ToolCallRow
          tool={{
            id: 'tool',
            name: 'write',
            title: 'Writing src/app.tsx',
            command: 'write',
            status: 'success'
          }}
        />
      )
    })

    const row = container.querySelector('.tool-call-row') as HTMLButtonElement
    expect(row.disabled).toBe(false)
    expect(row.tabIndex).toBe(-1)
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.title).toContain('Completed')
  })

  it('keeps copy available but hides mutating actions in a read-only transcript', async () => {
    await act(async () => {
      root.render(
        <MessageItem
          message={{
            id: 'read-only-message',
            role: 'user',
            content: 'Inspect this from the compact agent pane',
            timestamp: Date.now()
          }}
          index={0}
          isLoading={false}
          expandedThinking={new Set()}
          editingMessageId={null}
          editingGeometry={null}
          editingContent=""
          copiedMessageId={null}
          readOnly
          onToggleThinking={vi.fn()}
          onHandleArtifactResult={vi.fn()}
          onEditMessage={vi.fn()}
          onCancelEditMessage={vi.fn()}
          onConfirmEditMessage={vi.fn()}
          onCopyMessage={vi.fn()}
          onRetryMessage={vi.fn()}
          onSetEditingContent={vi.fn()}
          onApproveToolLimitDecision={vi.fn()}
          onDenyToolLimitDecision={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[aria-label="Copy message"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
    expect(container.querySelector('[aria-label="Retry message"]')).toBeNull()
  })

  it('renders app notices as compact status rows without chat hover metadata', async () => {
    await act(async () => {
      root.render(
        <MessageItem
          message={{
            id: 'notice',
            role: 'system',
            noticeTone: 'error',
            content: 'Agent run stopped: provider unavailable',
            timestamp: Date.now()
          }}
          index={0}
          isLoading={false}
          expandedThinking={new Set()}
          editingMessageId={null}
          editingGeometry={null}
          editingContent=""
          copiedMessageId={null}
          onToggleThinking={vi.fn()}
          onHandleArtifactResult={vi.fn()}
          onEditMessage={vi.fn()}
          onCancelEditMessage={vi.fn()}
          onConfirmEditMessage={vi.fn()}
          onCopyMessage={vi.fn()}
          onRetryMessage={vi.fn()}
          onSetEditingContent={vi.fn()}
          onApproveToolLimitDecision={vi.fn()}
          onDenyToolLimitDecision={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Agent run stopped')
    expect(container.querySelector('.message-meta')).toBeNull()
    expect(container.querySelector('.message-notice-error')).not.toBeNull()
  })

  it('shows generation speed but never raw token totals in hover metadata', async () => {
    await act(async () => {
      root.render(
        <MessageItem
          message={{
            id: 'speed',
            role: 'agent',
            content: 'Finished',
            timestamp: Date.now(),
            tokenUsage: { promptTokens: 12_000, completionTokens: 900, tokensPerSecond: 47.25 }
          }}
          index={0}
          isLoading={false}
          expandedThinking={new Set()}
          editingMessageId={null}
          editingGeometry={null}
          editingContent=""
          copiedMessageId={null}
          onToggleThinking={vi.fn()}
          onHandleArtifactResult={vi.fn()}
          onEditMessage={vi.fn()}
          onCancelEditMessage={vi.fn()}
          onConfirmEditMessage={vi.fn()}
          onCopyMessage={vi.fn()}
          onRetryMessage={vi.fn()}
          onSetEditingContent={vi.fn()}
          onApproveToolLimitDecision={vi.fn()}
          onDenyToolLimitDecision={vi.fn()}
        />
      )
    })

    expect(container.querySelector('.message-token-info')?.textContent).toBe('47.3 t/s')
    expect(container.querySelector('.message-meta')?.textContent).not.toContain('tok')
  })

  it('collapses completed work and leaves the final answer visible', async () => {
    await act(async () => {
      root.render(
        <MessageItem
          message={{
            id: 'completed-work',
            role: 'agent',
            content: 'I will inspect it. The fix is complete.',
            timestamp: 1_000,
            tokenUsage: {
              promptTokens: 1_000,
              completionTokens: 200,
              runStartedAt: 1_000,
              runCompletedAt: 202_000
            },
            segments: [
              { type: 'thinking', content: 'Inspect the implementation.' },
              { type: 'text', content: 'I will inspect it.' },
              {
                type: 'tool',
                tool: {
                  id: 'read-tool',
                  title: 'Read the renderer',
                  command: 'read',
                  status: 'success'
                }
              },
              { type: 'text', content: 'The fix is complete.' }
            ]
          }}
          index={0}
          isLoading={false}
          expandedThinking={new Set()}
          editingMessageId={null}
          editingGeometry={null}
          editingContent=""
          copiedMessageId={null}
          onToggleThinking={vi.fn()}
          onHandleArtifactResult={vi.fn()}
          onEditMessage={vi.fn()}
          onCancelEditMessage={vi.fn()}
          onConfirmEditMessage={vi.fn()}
          onCopyMessage={vi.fn()}
          onRetryMessage={vi.fn()}
          onSetEditingContent={vi.fn()}
          onApproveToolLimitDecision={vi.fn()}
          onDenyToolLimitDecision={vi.fn()}
        />
      )
    })

    const toggle = container.querySelector('.agent-work-toggle') as HTMLButtonElement
    expect(toggle.textContent).toContain('Worked for 3m 21s')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('The fix is complete.')
    expect(container.textContent).not.toContain('Read the renderer')

    await act(async () => toggle.click())
    expect(container.textContent).toContain('Read the renderer')
    expect(container.textContent).toContain('I will inspect it.')
  })

  it('updates the elapsed time while work is active', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(233_000)
    try {
      await act(async () => {
        root.render(
          <MessageItem
            message={{
              id: 'active-work',
              role: 'agent',
              content: '',
              timestamp: 1_000,
              tokenUsage: {
                promptTokens: 0,
                completionTokens: 0,
                runStartedAt: 1_000
              }
            }}
            index={0}
            isLoading
            expandedThinking={new Set()}
            editingMessageId={null}
            editingGeometry={null}
            editingContent=""
            copiedMessageId={null}
            onToggleThinking={vi.fn()}
            onHandleArtifactResult={vi.fn()}
            onEditMessage={vi.fn()}
            onCancelEditMessage={vi.fn()}
            onConfirmEditMessage={vi.fn()}
            onCopyMessage={vi.fn()}
            onRetryMessage={vi.fn()}
            onSetEditingContent={vi.fn()}
            onApproveToolLimitDecision={vi.fn()}
            onDenyToolLimitDecision={vi.fn()}
          />
        )
      })
      expect(container.querySelector('.agent-work-toggle')?.textContent).toContain(
        'Working for 3m 52s'
      )

      await act(async () => {
        vi.advanceTimersByTime(1_000)
      })
      expect(container.querySelector('.agent-work-toggle')?.textContent).toContain(
        'Working for 3m 53s'
      )
    } finally {
      await act(async () => root.render(<></>))
      vi.useRealTimers()
    }
  })
})
