// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageItem } from './MessageItem'

type Props = React.ComponentProps<typeof MessageItem>

const baseProps = {
  index: 0,
  isLoading: false,
  expandedThinking: new Set<string>(),
  editingMessageId: null,
  copiedMessageId: null,
  onToggleThinking: vi.fn(),
  onHandleArtifactResult: vi.fn(),
  onEditMessage: vi.fn(),
  onCopyMessage: vi.fn(),
  onRetryMessage: vi.fn(),
  onForkMessage: vi.fn(),
  onApproveToolLimitDecision: vi.fn(),
  onDenyToolLimitDecision: vi.fn()
}

describe('MessageItem', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { siteIcons: { get: vi.fn(async () => ({ dataUrl: null })) } }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const render = (props: Partial<Props> & Pick<Props, 'message'>): Promise<void> =>
    act(async () => root.render(<MessageItem {...baseProps} {...props} />))

  it('shows only the latest version of an artifact the reply revised', async () => {
    // Each fix made the artifact again under the same title, and every attempt,
    // broken ones included, stayed in the chat as its own card.
    const artifact = (code: string, title = 'Clima en Reno') => ({
      type: 'artifact' as const,
      artifact: { type: 'svg' as const, title, code, isStreaming: false }
    })
    await render({
      message: {
        id: 'reply',
        role: 'agent',
        content: 'Listo',
        timestamp: Date.now(),
        segments: [
          artifact('<svg data-version="1"></svg>'),
          artifact('<svg data-version="2"></svg>'),
          artifact('<svg data-version="other"></svg>', 'Otra card'),
          { type: 'text', content: 'Listo' }
        ]
      }
    })

    const cards = [...container.querySelectorAll('.artifact-segment')]
    expect(cards).toHaveLength(2)
    // Artifacts run in a sandbox; their code is in the chat's DOM only in code view.
    for (const card of cards) {
      await act(async () =>
        card.querySelector<HTMLButtonElement>('[aria-label="View code"]')!.click()
      )
    }
    const code = cards.map((card) => card.querySelector('.artifact-code')?.textContent).join(' ')
    expect(code).toContain('data-version="2"')
    expect(code).not.toContain('data-version="1"')
    expect(code).toContain('data-version="other"')
  })

  it('shows a goal completion as one line, with the older long headline shortened and evidence folded', async () => {
    await render({
      message: {
        id: 'goal-complete:goal-1',
        role: 'system',
        noticeTone: 'success',
        content: 'Goal complete — Ship the settings page\n\nAll tests pass',
        timestamp: Date.now()
      }
    })

    const notice = container.querySelector('.message-notice-success [role="status"]')!
    // The objective is the message above; the notice does not say it again.
    expect(notice.querySelector('strong')?.textContent).toBe('Goal complete')
    expect(notice.querySelector('details .system-notice-detail')?.textContent).toBe(
      'All tests pass'
    )
  })

  it('renders a compaction marker at its historical position between tool calls', async () => {
    const tool = (id: string, title: string) => ({
      type: 'tool' as const,
      tool: { id, title, command: 'read', status: 'success' as const }
    })
    await render({
      isLoading: true,
      message: {
        id: 'compaction-chronology',
        role: 'agent',
        content: '',
        timestamp: Date.now(),
        segments: [
          tool('before', 'Tool before marker'),
          {
            type: 'summary',
            content: '<historical_context>handoff</historical_context>',
            summary: { originalTokens: 10_000, newTokens: 1_000, messagesCompacted: 12 }
          },
          tool('after', 'Tool after marker')
        ]
      }
    })

    const text = container.querySelector('.message-segments')?.textContent || ''
    expect(text.indexOf('Tool before marker')).toBeLessThan(text.indexOf('Context compacted'))
    expect(text.indexOf('Context compacted')).toBeLessThan(text.indexOf('Tool after marker'))
    expect(container.querySelectorAll('.agent-work-disclosure')).toHaveLength(2)
  })

  it('keeps a working reply that ends in text from looking finished', async () => {
    const message = {
      id: 'still-working',
      role: 'agent' as const,
      content: 'Fixing those to derive from metres:',
      timestamp: Date.now() - 21 * 60_000,
      segments: [
        { type: 'thinking' as const, content: 'Checking the render' },
        { type: 'text' as const, content: 'Fixing those to derive from metres:' }
      ],
      tokenUsage: { promptTokens: 48_000, completionTokens: 1_411, tokensPerSecond: 12.5 }
    }

    // The model can spend minutes writing its next tool call with nothing new on screen; the
    // live line at the foot of the reply keeps counting.
    await render({ message, isLoading: true })
    expect(container.querySelector('.agent-run-stats')?.textContent).toContain('21m')
    expect(container.querySelector('.message-meta')).toBeNull()

    await render({ message, isLoading: false })
    expect(container.querySelector('.agent-run-stats')).toBeNull()
    expect(container.querySelector('.message-meta')).not.toBeNull()
  })

  it('times a reply from the run that wrote it, so a retry starts the clock again', async () => {
    await render({
      message: {
        id: 'long-task',
        role: 'agent',
        content: 'Done.',
        timestamp: 5_000_000,
        tokenUsage: {
          promptTokens: 10,
          completionTokens: 5,
          // A retry, long after the message it answers was first sent.
          runStartedAt: 4_000_000,
          runCompletedAt: 4_200_000
        },
        segments: [
          { type: 'tool', tool: { id: 't', title: 'Read', command: 'read', status: 'success' } },
          { type: 'text', content: 'Done.' }
        ]
      }
    })
    // 200 s from the retry to the end: 3m 20s, once, in the footer.
    expect(container.querySelector('.message-run-stats')?.textContent).toContain(
      'Worked for 3m 20s'
    )
    expect(container.textContent?.match(/Work(ed|ing) for/g)).toHaveLength(1)
  })

  it('collapses completed work and leaves the final answer visible', async () => {
    await render({
      message: {
        id: 'completed-work',
        role: 'agent',
        content: 'I will inspect it. The fix is complete.',
        timestamp: 1_000,
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
      }
    })

    expect(container.textContent).toContain('The fix is complete.')
    expect(container.textContent).not.toContain('Read the renderer')

    await act(async () =>
      (container.querySelector('.agent-work-toggle') as HTMLButtonElement).click()
    )
    expect(container.textContent).toContain('Read the renderer')
    expect(container.textContent).toContain('I will inspect it.')
  })

  it('shows a steered message where it was sent, outside the folded work', async () => {
    await render({
      message: {
        id: 'steered-reply',
        role: 'agent',
        content: 'Formatting with spaces. Switched to tabs.',
        timestamp: 1_000,
        segments: [
          { type: 'text', content: 'Formatting with spaces.' },
          {
            type: 'tool',
            tool: { id: 'format', title: 'Format files', command: 'shell', status: 'success' }
          },
          {
            type: 'steer',
            steer: { id: 'steer-1', content: 'Use tabs instead.', timestamp: 2_000 }
          },
          { type: 'text', content: 'Switched to tabs.' }
        ]
      }
    })

    const steer = container.querySelector('.steer-segment')
    expect(steer?.textContent).toContain('Use tabs instead.')
    expect(steer?.closest('.agent-work-disclosure')).toBeNull()
    expect(container.querySelector('[data-final-answer]')?.textContent).toContain(
      'Switched to tabs.'
    )
  })

  it('offers one Continue on an interrupted reply that can still be continued', async () => {
    const onContinueRun = vi.fn(() => new Promise<void>(() => undefined))
    const message = {
      id: 'interrupted-reply',
      runId: 'run-1',
      role: 'agent' as const,
      content: 'Deploying.',
      timestamp: 1_000,
      segments: [
        { type: 'text' as const, content: 'Deploying.' },
        {
          type: 'tool' as const,
          tool: { id: 'deploy', title: 'Deploy', command: 'shell', status: 'error' as const }
        },
        {
          type: 'run_error' as const,
          runError: {
            code: 'interrupted',
            message: 'SideKick closed before this reply finished.',
            retryable: true
          }
        }
      ]
    }
    await render({ message, onContinueRun })

    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Continue'
    ) as HTMLButtonElement
    expect(button.closest('.agent-work-disclosure')).toBeNull()
    await act(async () => button.click())
    await act(async () => button.click())
    expect(onContinueRun).toHaveBeenCalledOnce()
    expect(onContinueRun).toHaveBeenCalledWith(message)

    // Once continued, or once something else follows it, the interruption is a quiet note: the
    // reply below carries on, so it is not shown as a failure.
    await render({ message: { ...message } })
    expect(container.querySelector('.run-error-segment')).toBeNull()
    expect(container.querySelector('.run-interrupted-note')).not.toBeNull()
  })

  it('shows a question the agent is waiting on outside the folded work', async () => {
    // The question sat inside the collapsed work block, so the run waited on an answer the user
    // could not see until they expanded it.
    await render({
      isLoading: true,
      onResolveAgentInteraction: vi.fn(),
      message: {
        id: 'asking',
        runId: 'run-1',
        role: 'agent',
        content: '',
        timestamp: 1_000,
        segments: [
          { type: 'thinking', content: 'Ask first.' },
          {
            type: 'tool',
            tool: { id: 'ask', title: 'ask user', command: 'ask_user', status: 'running' }
          },
          {
            type: 'interaction',
            interaction: {
              id: 'question-1',
              kind: 'question',
              status: 'pending',
              request: {
                questions: [
                  {
                    id: 'install',
                    question: 'Install ws-scrcpy now?',
                    options: [{ label: 'Yes' }, { label: 'Later' }]
                  }
                ]
              }
            }
          }
        ]
      }
    })

    const question = [...container.querySelectorAll('*')].find(
      (element) => element.children.length === 0 && element.textContent === 'Install ws-scrcpy now?'
    )
    expect(question!.closest('.agent-work-disclosure')).toBeNull()
  })

  it('offers Continue on a reply that failed mid-run, and asks before Retry discards it', async () => {
    // Retry on a dropped connection discarded 18 minutes of work and undid its file changes.
    const onContinueRun = vi.fn(() => new Promise<void>(() => undefined))
    const onRetryMessage = vi.fn()
    const message = {
      id: 'failed-reply',
      runId: 'run-failed',
      role: 'agent' as const,
      content: '',
      timestamp: 1_000,
      segments: [
        {
          type: 'run_error' as const,
          runError: {
            code: 'transient',
            message: 'Lost the connection to the model server while it was replying.',
            retryable: true
          }
        }
      ]
    }
    await render({ message, onRetryMessage, onContinueRun })
    const button = (label: string): HTMLButtonElement | undefined =>
      [...container.querySelectorAll('.run-error-segment button')].find(
        (candidate) => candidate.textContent?.trim() === label
      ) as HTMLButtonElement | undefined

    await act(async () => button('Retry')!.click())
    expect(onRetryMessage).not.toHaveBeenCalled()
    await act(async () => button('Cancel')!.click())
    expect(button('Discard and retry')).toBeUndefined()

    await act(async () => button('Retry')!.click())
    await act(async () => button('Discard and retry')!.click())
    expect(onRetryMessage).toHaveBeenCalledWith(message)
    await act(async () => button('Cancel')!.click())

    await act(async () => button('Continue')!.click())
    expect(onContinueRun).toHaveBeenCalledWith(message)
    // While it continues, the reply cannot also be started over.
    expect(button('Retry')!.disabled).toBe(true)
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
    const content = (): string => container.querySelector('.actions-content')?.textContent ?? ''

    await render({
      message,
      isLoading: true,
      expandedThinking: new Set(['live-thinking-group-0-thinking-0'])
    })
    // A running reply shows its current step; the full list opens from the header.
    await act(async () =>
      (container.querySelector('.agent-work-toggle') as HTMLButtonElement).click()
    )
    expect(content()).toContain('First thought')
    expect(content()).not.toContain('Second thought')

    await render({
      message,
      isLoading: true,
      expandedThinking: new Set(['live-thinking-group-0-thinking-2'])
    })
    expect(container.querySelectorAll('.actions-content')).toHaveLength(1)
    expect(content()).not.toContain('First thought')
    expect(content()).toContain('Second thought')
  })

  it('keeps a generated artifact outside the collapsed work disclosure', async () => {
    await render({
      message: {
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
      }
    })

    const disclosure = container.querySelector('.agent-work-disclosure')
    const artifact = container.querySelector('.artifact-segment')
    expect(artifact).not.toBeNull()
    expect(disclosure?.contains(artifact)).toBe(false)
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
    await render({
      message: {
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
      }
    })

    expect(container.textContent).toContain('Build passed.')
    expect(container.textContent).toContain('Earlier attempts (1)')
    expect(container.querySelector('.verification-history')?.getAttribute('open')).toBeNull()
  })

  it('keeps the answer last to read, with the verification pass in its footer', async () => {
    await render({
      message: {
        id: 'folded-verification',
        role: 'agent',
        content: 'Here is the full answer.',
        timestamp: 1_000,
        segments: [
          { type: 'thinking', content: 'Planning the edit' },
          { type: 'text', content: 'Here is the full answer.' },
          {
            type: 'verification',
            content: 'All tests pass.',
            steps: [{ type: 'text', content: 'Running the tests.' }],
            verification: {
              status: 'passed',
              workspaceRoot: 'C:\\project',
              baselineRevision: 0,
              currentRevision: 1,
              changedPaths: ['src/app.ts'],
              evidence: [],
              suggestedChecks: [],
              headline: 'Verified with test.'
            }
          }
        ]
      }
    })

    const answer = container.querySelector('[data-final-answer]')
    expect(answer?.textContent).toContain('Here is the full answer.')
    expect(answer?.closest('.agent-work-disclosure')).toBeNull()
    // Checks are work: the reply body ends with the answer, and the result is one footer item.
    expect(container.querySelector('.message-segments .verification-detail')).toBeNull()
    const verification = container.querySelector('.message-meta .message-verification')
    expect(verification?.textContent).toContain('All tests pass.')
    expect(verification?.textContent).toContain('Running the tests.')
  })

  it('shows a saved reply whose only answer is its verification note as the answer', async () => {
    const renderNote = (
      suggestedChecks: Array<{ kind: 'test'; command: string; source: string }>
    ): Promise<void> =>
      render({
        message: {
          id: 'legacy-note',
          role: 'agent',
          content: '',
          timestamp: 1_000,
          segments: [
            { type: 'thinking', content: 'Checking the file' },
            {
              type: 'verification',
              content: 'Cleaned up the page.',
              verification: {
                status: 'unverified',
                workspaceRoot: '/project',
                baselineRevision: 0,
                currentRevision: 1,
                changedPaths: ['site/index.html'],
                evidence: [],
                suggestedChecks,
                headline: 'Workspace changes have not been verified.',
                detail: 'Run the smallest relevant test before finishing.'
              }
            }
          ]
        }
      })

    await renderNote([{ kind: 'test', command: 'npm test', source: 'package.json' }])
    expect(container.querySelector('.message-segments')?.textContent).toContain(
      'Cleaned up the page.'
    )
    // The answer is not repeated in the footer, and saved wording gives way to the current one.
    const verification = container.querySelector('.message-verification')
    expect(verification?.textContent).not.toContain('Cleaned up the page.')
    expect(verification?.textContent).not.toContain('Run the smallest relevant test')

    // A project with no check to suggest has nothing to report, in saved replies too.
    await renderNote([])
    expect(container.querySelector('.message-verification')).toBeNull()
    expect(container.querySelector('.message-segments')?.textContent).toContain(
      'Cleaned up the page.'
    )
  })

  it('offers to rewind to before a message, with or without the file changes since', async () => {
    const rewind = vi.fn()
    const message = { id: 'ask', role: 'user' as const, content: 'Tighten it', timestamp: 1_000 }
    await render({ message, onRewindMessage: rewind, rewindCanRestoreFiles: true })

    const item = container.querySelector('.message-rewind') as HTMLDetailsElement
    const choice = (label: string): HTMLButtonElement =>
      [...item.querySelectorAll('button')].find((button) => button.textContent === label)!
    await act(async () => choice('Chat only').click())
    await act(async () => choice('Rewind chat and files').click())
    expect(rewind.mock.calls).toEqual([
      [message, false],
      [message, true]
    ])
  })

  it('updates the elapsed time while work is active', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(233_000)
    try {
      await render({
        isLoading: true,
        message: {
          id: 'active-work',
          role: 'agent',
          content: '',
          timestamp: 1_000,
          tokenUsage: { promptTokens: 0, completionTokens: 0, runStartedAt: 1_000 }
        }
      })
      const stats = (): string => container.querySelector('.agent-run-stats')?.textContent ?? ''
      expect(stats()).toContain('3m 52s')

      await act(async () => {
        vi.advanceTimersByTime(1_000)
      })
      expect(stats()).toContain('3m 53s')
    } finally {
      await act(async () => root.render(<></>))
      vi.useRealTimers()
    }
  })

  it('says the reply is compacting context rather than still in its last step', async () => {
    const renderRun = (compacting: boolean): Promise<void> =>
      render({
        isLoading: true,
        message: {
          id: 'compacting-work',
          role: 'agent',
          content: '',
          timestamp: 1_000,
          segments: [
            {
              type: 'tool',
              tool: { id: 'tool-1', title: 'Read file', command: '', status: 'success' }
            }
          ],
          tokenUsage: {
            promptTokens: 150_000,
            completionTokens: 0,
            runStartedAt: 1_000,
            ...(compacting ? { compacting: { startedAt: 2_000 } } : {})
          }
        }
      })
    const stats = (): Element | null => container.querySelector('.agent-run-stats')
    try {
      await renderRun(true)
      expect(stats()?.getAttribute('data-activity')).toBe('compacting')

      await renderRun(false)
      expect(stats()?.getAttribute('data-activity')).not.toBe('compacting')
    } finally {
      await act(async () => root.render(<></>))
    }
  })

  it('does not re-render when the chat re-renders around it, as it does on every keystroke', async () => {
    // A new fork callback per render defeated the memo, so typing re-rendered
    // every message: markdown re-parsed and links flickered.
    let contentReads = 0
    const message = {
      id: 'reply',
      role: 'agent' as const,
      timestamp: 1,
      get content() {
        contentReads++
        return 'See [the docs](https://example.com)'
      }
    }
    const Chat = ({ draft }: { draft: string }) => (
      <>
        <span data-draft={draft} />
        <MessageItem {...baseProps} message={message} />
      </>
    )
    await act(async () => root.render(<Chat draft="a" />))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const readsAfterMount = contentReads
    expect(readsAfterMount).toBeGreaterThan(0)

    await act(async () => root.render(<Chat draft="ab" />))
    await act(async () => root.render(<Chat draft="abc" />))

    expect(container.querySelectorAll('[data-draft="abc"]')).toHaveLength(1)
    expect(contentReads).toBe(readsAfterMount)
  })

  it('shows a running reply its current step on one line, replaced by the next', async () => {
    const tool = (id: string, title: string, status: 'success' | 'running') => ({
      type: 'tool' as const,
      tool: { id, title, command: 'shell', status, input: { command: title } }
    })
    const reply = (segments: Props['message']['segments']) => ({
      id: 'live-run',
      role: 'agent' as const,
      content: '',
      timestamp: 1,
      segments
    })
    await render({
      isLoading: true,
      message: reply([
        { type: 'thinking', content: 'Plan the pull' },
        tool('pull', 'podman pull sglang', 'running')
      ])
    })

    const live = () => container.querySelector('.agent-work-live')
    expect(live()?.textContent).toContain('podman pull sglang')
    expect(live()?.textContent).not.toContain('Plan the pull')
    expect(container.querySelector('.agent-work-content')).toBeNull()

    await render({
      isLoading: true,
      message: reply([
        { type: 'thinking', content: 'Plan the pull' },
        tool('pull', 'podman pull sglang', 'success'),
        { type: 'thinking', content: 'Now compare the profiles' }
      ])
    })
    expect(live()?.textContent).toContain('Now compare the profiles')

    await act(async () => (live() as HTMLElement).click())
    expect(live()).toBeNull()
    expect(container.querySelector('.agent-work-content')?.textContent).toContain(
      'podman pull sglang'
    )
  })

  it('mounts only the latest steps of a long work block, with the rest one click away', async () => {
    // Hundreds of steps mounted and re-rendered on every update made a
    // long-running agent slower to watch the longer it worked.
    const segments = Array.from({ length: 45 }, (_, index) => [
      { type: 'thinking' as const, content: `Step ${index} reasoning` },
      { type: 'text' as const, content: `Progress ${index}` }
    ]).flat()
    await render({
      isLoading: true,
      message: {
        id: 'long-run',
        role: 'agent',
        content: '',
        timestamp: 1,
        segments: [...segments, { type: 'text', content: 'Done' }]
      }
    })
    // A running reply shows its current step; the full list opens from the header.
    await act(async () =>
      (container.querySelector('.agent-work-toggle') as HTMLButtonElement).click()
    )

    const visibleSteps = () =>
      container.querySelectorAll('.agent-work-content > .segment-group').length
    const earlier = container.querySelector('.agent-work-earlier') as HTMLButtonElement
    expect(visibleSteps()).toBe(30)
    const hidden = Number(/Show (\d+) earlier steps/.exec(earlier.textContent ?? '')?.[1])
    expect(hidden).toBeGreaterThan(50)
    // The newest step is among those shown, the oldest is not.
    const shown = container.querySelector('.agent-work-content')?.textContent ?? ''
    expect(shown).toContain('Step 44 reasoning')
    expect(shown).not.toContain('Step 0 reasoning')

    await act(async () => earlier.click())
    expect(container.querySelector('.agent-work-earlier')).toBeNull()
    expect(visibleSteps()).toBe(30 + hidden)
  })
})
