// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageItem } from './MessageItem'
import ToolCallRow from './ToolCallRow'
import AgentInteractionCard from './AgentInteractionCard'

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
    const forkMessage = vi.fn()
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
          onForkMessage={forkMessage}
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
    expect(container.querySelector('[aria-label="Fork from this message"]')).not.toBeNull()

    const copyButton = container.querySelector('[aria-label="Copy message"]') as HTMLButtonElement
    const editButton = container.querySelector(
      '[aria-label="Edit and resend"]'
    ) as HTMLButtonElement
    const retryButton = container.querySelector('[aria-label="Send again"]') as HTMLButtonElement
    const forkButton = container.querySelector(
      '[aria-label="Fork from this message"]'
    ) as HTMLButtonElement
    await act(async () => {
      copyButton.click()
      editButton.click()
      retryButton.click()
      forkButton.click()
    })
    expect(copyMessage).toHaveBeenCalledOnce()
    expect(editMessage).toHaveBeenCalledOnce()
    expect(retryMessage).toHaveBeenCalledOnce()
    expect(forkMessage).toHaveBeenCalledOnce()
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

  it('expands a compaction marker to show and copy the model-facing context', async () => {
    const writeText = vi.fn(async () => ({ success: true }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...window.api, clipboard: { writeText } }
    })
    const modelContext = '<historical_context>\nDurable handoff\n</historical_context>'

    await act(async () => {
      root.render(
        <MessageItem
          message={{
            id: 'compaction',
            role: 'agent',
            content: '',
            timestamp: Date.now(),
            segments: [
              {
                type: 'summary',
                content: modelContext,
                summary: { originalTokens: 12_000, newTokens: 2_000, messagesCompacted: 24 }
              }
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

    const disclosure = container.querySelector('.summary-segment-compact') as HTMLDetailsElement
    expect(disclosure.open).toBe(false)
    expect(disclosure.textContent).toContain('24 messages')
    expect(container.querySelector('.summary-content')?.textContent).toBe(modelContext)

    await act(async () => {
      ;(
        container.querySelector('[aria-label="Copy compacted context"]') as HTMLButtonElement
      ).click()
    })
    expect(writeText).toHaveBeenCalledWith(modelContext)
  })

  it('renders a compaction marker at its historical position between tool calls', async () => {
    await act(async () => {
      root.render(
        <MessageItem
          message={{
            id: 'compaction-chronology',
            role: 'agent',
            content: '',
            timestamp: Date.now(),
            segments: [
              {
                type: 'tool',
                tool: {
                  id: 'before',
                  title: 'Tool before marker',
                  command: 'read',
                  status: 'success'
                }
              },
              {
                type: 'summary',
                content: '<historical_context>handoff</historical_context>',
                summary: { originalTokens: 10_000, newTokens: 1_000, messagesCompacted: 12 }
              },
              {
                type: 'tool',
                tool: {
                  id: 'after',
                  title: 'Tool after marker',
                  command: 'write',
                  status: 'success'
                }
              }
            ]
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

    const text = container.querySelector('.message-segments')?.textContent || ''
    expect(text.indexOf('Tool before marker')).toBeLessThan(text.indexOf('Context compacted'))
    expect(text.indexOf('Context compacted')).toBeLessThan(text.indexOf('Tool after marker'))
    expect(container.querySelectorAll('.agent-work-disclosure')).toHaveLength(2)
  })

  it('shows generation speed with a compact, inspectable usage summary', async () => {
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
    expect(container.querySelector('.message-run-stats > summary')?.textContent).toContain(
      '12,900 tokens'
    )
    expect(container.querySelector('.message-run-stats-popover')?.textContent).toContain(
      'Input 12,000'
    )
  })

  it('offers message-level undo for a response that changed this workspace', async () => {
    const undo = vi.fn()
    await act(async () => {
      root.render(
        <MessageItem
          message={{
            id: 'changed-files',
            role: 'agent',
            content: 'Implemented it.',
            timestamp: Date.now(),
            checkpointHash: 'abc1234',
            checkpointWorkspaceRoot: 'C:\\project'
          }}
          index={0}
          isLoading={false}
          expandedThinking={new Set()}
          editingMessageId={null}
          editingGeometry={null}
          editingContent=""
          copiedMessageId={null}
          workspaceFolder={'C:\\project'}
          onUndoCheckpoint={undo}
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

    const button = container.querySelector('[aria-label="Undo file changes"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    await act(async () => button.click())
    expect(undo).toHaveBeenCalledWith('abc1234')
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

  it('renders thinking and tool activity in the order it happened', async () => {
    await act(async () => {
      root.render(
        <MessageItem
          message={{
            id: 'chronological-work',
            role: 'agent',
            content: '',
            timestamp: Date.now(),
            segments: [
              { type: 'thinking', content: 'First thought' },
              {
                type: 'tool',
                tool: {
                  id: 'first-tool',
                  title: 'First command',
                  command: 'read',
                  status: 'success'
                }
              },
              { type: 'thinking', content: 'Second thought' },
              {
                type: 'tool',
                tool: {
                  id: 'second-tool',
                  title: 'Second command',
                  command: 'write',
                  status: 'success'
                }
              }
            ]
          }}
          index={0}
          isLoading
          expandedThinking={
            new Set([
              'chronological-work-group-0-thinking-0',
              'chronological-work-group-0-thinking-2'
            ])
          }
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

    const workText = container.querySelector('.actions-group')?.textContent || ''
    expect(workText.indexOf('First thought')).toBeLessThan(workText.indexOf('First command'))
    expect(workText.indexOf('First command')).toBeLessThan(workText.indexOf('Second thought'))
    expect(workText.indexOf('Second thought')).toBeLessThan(workText.indexOf('Second command'))
  })

  it('re-renders immediately when switching between expanded thinking blocks', async () => {
    const message = {
      id: 'live-thinking',
      role: 'agent' as const,
      content: '',
      timestamp: Date.now(),
      segments: [
        { type: 'thinking' as const, content: 'First thought' },
        {
          type: 'tool' as const,
          tool: { id: 'read', title: 'Read file', command: 'read', status: 'success' as const }
        },
        { type: 'thinking' as const, content: 'Second thought' }
      ]
    }
    const common = {
      message,
      index: 0,
      isLoading: true,
      editingMessageId: null,
      editingGeometry: null,
      editingContent: '',
      copiedMessageId: null,
      onToggleThinking: vi.fn(),
      onHandleArtifactResult: vi.fn(),
      onEditMessage: vi.fn(),
      onCancelEditMessage: vi.fn(),
      onConfirmEditMessage: vi.fn(),
      onCopyMessage: vi.fn(),
      onRetryMessage: vi.fn(),
      onSetEditingContent: vi.fn(),
      onApproveToolLimitDecision: vi.fn(),
      onDenyToolLimitDecision: vi.fn()
    }

    await act(async () => {
      root.render(
        <MessageItem {...common} expandedThinking={new Set(['live-thinking-group-0-thinking-0'])} />
      )
    })
    expect(container.querySelectorAll('.actions-content')).toHaveLength(1)
    expect(container.querySelector('.actions-content')?.textContent).toContain('First thought')
    expect(container.querySelector('.actions-content')?.textContent).not.toContain('Second thought')

    await act(async () => {
      root.render(
        <MessageItem {...common} expandedThinking={new Set(['live-thinking-group-0-thinking-2'])} />
      )
    })
    expect(container.querySelectorAll('.actions-content')).toHaveLength(1)
    expect(container.querySelector('.actions-content')?.textContent).not.toContain('First thought')
    expect(container.querySelector('.actions-content')?.textContent).toContain('Second thought')
  })

  it('compacts an approval immediately and treats deny as a decision', async () => {
    let finish!: () => void
    const onResolve = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    await act(async () => {
      root.render(
        <AgentInteractionCard
          interaction={{
            id: 'permission-1',
            kind: 'permission',
            status: 'pending',
            request: {
              title: 'Run command?',
              arguments: { command: 'npm test', environment: { large: 'payload' } }
            }
          }}
          onResolve={onResolve}
        />
      )
    })

    expect(container.querySelector('.agent-interaction-detail-disclosure')).not.toBeNull()
    const deny = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Deny'
    ) as HTMLButtonElement
    await act(async () => deny.click())

    expect(container.textContent).toContain('Denying…')
    expect(container.querySelector('.agent-interaction-detail-disclosure')).toBeNull()
    expect(onResolve).toHaveBeenCalledWith('permission-1', { approved: false })
    await act(async () => finish())
    expect(container.textContent).toContain('Denied')
    expect(container.textContent).not.toContain('Denying…')
  })

  it('keeps a generated artifact outside the collapsed work disclosure', async () => {
    await act(async () => {
      root.render(
        <MessageItem
          message={{
            id: 'artifact-output',
            role: 'agent',
            content: 'The dashboard is ready.',
            timestamp: 1_000,
            segments: [
              {
                type: 'tool',
                tool: {
                  id: 'weather-tool',
                  title: 'Checking weather',
                  command: 'web_search',
                  status: 'success'
                }
              },
              {
                type: 'artifact',
                artifact: {
                  type: 'svg',
                  title: 'Weather dashboard',
                  code: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>'
                }
              },
              { type: 'text', content: 'The dashboard is ready.' }
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

    const disclosure = container.querySelector('.agent-work-disclosure')
    const artifact = container.querySelector('.artifact-segment')
    expect(container.querySelector('.agent-work-toggle')?.getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(artifact).not.toBeNull()
    expect(disclosure?.contains(artifact)).toBe(false)
    expect(container.textContent).toContain('Weather dashboard')
    expect(container.textContent).toContain('The dashboard is ready.')
    expect(container.textContent).not.toContain('Checking weather')
  })

  it('shows the authoritative verification and collapses earlier attempts', async () => {
    const evidence = (
      id: string,
      status: 'passed' | 'failed',
      summary: string,
      completedAt: number
    ) => ({
      id,
      runId: 'run-1',
      workspaceRoot: 'C:\\project',
      revision: 4,
      kind: 'build' as const,
      scope: 'workspace' as const,
      source: 'command' as const,
      status,
      summary,
      changedPaths: ['src/app.ts'],
      startedAt: completedAt - 10,
      completedAt
    })
    await act(async () => {
      root.render(
        <MessageItem
          message={{
            id: 'verified-output',
            role: 'agent',
            content: 'Done.',
            timestamp: 1_000,
            segments: [
              {
                type: 'verification',
                verification: {
                  status: 'passed',
                  workspaceRoot: 'C:\\project',
                  baselineRevision: 3,
                  currentRevision: 4,
                  changedPaths: ['src/app.ts'],
                  evidence: [
                    evidence('failed', 'failed', 'Build failed.', 10),
                    evidence('passed', 'passed', 'Build passed.', 20)
                  ],
                  suggestedChecks: [],
                  headline: 'Verified with build.'
                }
              }
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

    const verification = container.querySelector('.verification-segment') as HTMLDetailsElement
    verification.open = true
    expect(container.textContent).toContain('Build passed.')
    expect(container.textContent).toContain('Earlier attempts (1)')
    expect(container.querySelector('.verification-history')?.getAttribute('open')).toBeNull()
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
        'Waiting for model for 3m 52s'
      )

      await act(async () => {
        vi.advanceTimersByTime(1_000)
      })
      expect(container.querySelector('.agent-work-toggle')?.textContent).toContain(
        'Waiting for model for 3m 53s'
      )
    } finally {
      await act(async () => root.render(<></>))
      vi.useRealTimers()
    }
  })
})
