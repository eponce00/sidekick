// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentInteractionCard from './AgentInteractionCard'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('AgentInteractionCard question workflow', () => {
  let container: HTMLDivElement
  let root: Root
  let beginBrowserHumanTakeover: ReturnType<typeof vi.fn>
  let completeBrowserHumanTakeover: ReturnType<typeof vi.fn>

  beforeEach(() => {
    beginBrowserHumanTakeover = vi.fn()
    completeBrowserHumanTakeover = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        agentRuns: {
          beginBrowserHumanTakeover,
          completeBrowserHumanTakeover
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('marks accumulated choices so selection survives a pointer resting elsewhere', async () => {
    // Selection used to share one rule with hover, so a chosen option looked
    // identical to whichever option the pointer happened to be over.
    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={{
            id: 'question-mark',
            kind: 'question',
            status: 'pending',
            request: {
              questions: [
                {
                  id: 'density',
                  question: 'How compact?',
                  multiSelect: true,
                  options: [{ label: 'Comfortable' }, { label: 'Compact' }]
                }
              ]
            }
          }}
          onResolve={vi.fn()}
        />
      )
    )
    const option = (name: string): HTMLButtonElement =>
      [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes(name)
      )!

    await act(async () => option('Comfortable').click())

    const chosen = option('Comfortable')
    const other = option('Compact')
    expect(chosen.classList.contains('selected')).toBe(true)
    expect(other.classList.contains('selected')).toBe(false)
    // The mark carries a tick only on the chosen option, independent of hover.
    expect(chosen.querySelector('.agent-question-mark svg')).not.toBeNull()
    expect(other.querySelector('.agent-question-mark svg')).toBeNull()
  })

  it('says how many answers a question accepts', async () => {
    const render = async (multiSelect: boolean): Promise<void> => {
      await act(async () =>
        root.render(
          <AgentInteractionCard
            interaction={{
              id: `question-${multiSelect}`,
              kind: 'question',
              status: 'pending',
              request: {
                questions: [
                  {
                    id: 'panels',
                    question: 'Which panels?',
                    multiSelect,
                    options: [{ label: 'Files' }, { label: 'Browser' }]
                  }
                ]
              }
            }}
            onResolve={vi.fn()}
          />
        )
      )
    }

    await render(false)
    // Choosing a single answer sends it, so the choices are buttons rather
    // than radios, which arrow keys would select as they move.
    expect(container.querySelector('[role="checkbox"]')).toBeNull()
    expect(container.querySelector('.agent-question-hint')).toBeNull()

    await render(true)
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(2)
    expect(container.querySelector('.agent-question-options')?.classList.contains('is-multi')).toBe(
      true
    )
    expect(container.textContent).toContain('Choose any that apply')
    // The choices are named by the question they answer.
    const group = container.querySelector('.agent-question-options')!
    const prompt = document.getElementById(group.getAttribute('aria-labelledby')!)
    expect(prompt?.textContent).toBe('Which panels?')
  })

  it('pages through multi-select questions and submits selected values', async () => {
    const resolve = vi.fn()
    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={{
            id: 'question-1',
            kind: 'question',
            status: 'pending',
            request: {
              questions: [
                {
                  id: 'features',
                  header: 'Scope',
                  question: 'Which features?',
                  multiSelect: true,
                  options: [
                    { label: 'Files', description: 'File tools', recommended: true },
                    { label: 'Web', description: 'Web tools' }
                  ]
                },
                {
                  id: 'format',
                  question: 'Which format?',
                  options: [{ label: 'Compact' }, { label: 'Detailed' }]
                }
              ]
            }
          }}
          onResolve={resolve}
        />
      )
    )

    const option = (name: string): HTMLButtonElement =>
      [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes(name)
      )!
    await act(async () => {
      option('Files').click()
      option('Web').click()
    })
    expect(option('Files').getAttribute('aria-checked')).toBe('true')
    await act(async () => option('Next').click())
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe(
      'Question 2 of 2 from the agent'
    )
    expect(container.querySelector('.agent-question-progress')?.textContent).toBe('2 of 2')
    // Focus follows to the new question instead of dropping to the page.
    expect(document.activeElement?.textContent).toContain('Compact')
    // The second question takes one answer, so choosing it is the answer and
    // there is no separate confirmation to press.
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent === 'Send answers')
    ).toBe(false)
    await act(async () => option('Compact').click())
    expect(resolve).toHaveBeenCalledWith('question-1', {
      features: ['Files', 'Web'],
      format: 'Compact'
    })
  })

  it('supports custom answers, back navigation, skip, and cancellation', async () => {
    const resolve = vi.fn()
    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={{
            id: 'question-2',
            kind: 'question',
            status: 'pending',
            request: {
              questions: [
                { id: 'name', question: 'Name it' },
                {
                  id: 'color',
                  question: 'Choose a color',
                  options: [{ label: 'Blue' }, { label: 'Green' }]
                }
              ]
            }
          }}
          onResolve={resolve}
        />
      )
    )
    const input = container.querySelector('input') as HTMLInputElement
    await act(async () => setInputValue(input, 'Sidekick'))
    const button = (label: string): HTMLButtonElement =>
      [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label))!
    const send = (): HTMLButtonElement =>
      container.querySelector('.agent-question-send') as HTMLButtonElement
    await act(async () => send().click())
    await act(async () => button('Back').click())
    // The typed answer is still there on the way back.
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('Sidekick')
    await act(async () => send().click())
    await act(async () => button('Skip').click())
    expect(resolve).toHaveBeenCalledWith('question-2', { name: 'Sidekick' })

    resolve.mockClear()
    await act(async () => button('Cancel').click())
    expect(resolve).toHaveBeenCalledWith('question-2', {}, true)
  })

  it('collects a written answer without hiding the field behind a button', async () => {
    const resolve = vi.fn()
    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={{
            id: 'question-3',
            kind: 'question',
            status: 'pending',
            request: {
              questions: [
                {
                  id: 'editor',
                  question: 'Which editor?',
                  options: [{ label: 'VS Code' }, { label: 'Cursor' }]
                }
              ]
            }
          }}
          onResolve={resolve}
        />
      )
    )
    expect(
      [...container.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('Something else')
      )
    ).toBe(false)
    const input = container.querySelector('input') as HTMLInputElement
    await act(async () => setInputValue(input, 'Zed'))
    const send = container.querySelector('.agent-question-send') as HTMLButtonElement
    await act(async () => send.click())
    expect(resolve).toHaveBeenCalledWith('question-3', { editor: 'Zed' })

    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={{
            id: 'question-3',
            kind: 'question',
            status: 'resolved',
            request: {
              questions: [
                {
                  id: 'editor',
                  header: 'Editor',
                  question: 'Which editor?',
                  options: [{ label: 'VS Code' }, { label: 'Cursor' }]
                },
                { id: 'theme', header: 'Theme', question: 'Which theme?', options: [] }
              ]
            },
            response: { editor: 'Zed' }
          }}
          onResolve={resolve}
        />
      )
    )
    // Answered, the card folds to one row: what was asked, then what was chosen.
    const row = container.querySelector('.agent-question-answered') as HTMLButtonElement
    expect(row.textContent).toContain('2 questions')
    expect(row.textContent).toContain('Zed · Skipped')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.agent-question-summary')).toBeNull()
    expect(container.querySelector('input')).toBeNull()

    await act(async () => row.click())
    expect(row.getAttribute('aria-expanded')).toBe('true')
    const summary = container.querySelector('.agent-question-summary') as HTMLElement
    expect(row.getAttribute('aria-controls')).toBe(summary.id)
    expect(summary.textContent).toContain('Which editor?')
    expect(summary.textContent).toContain('Zed')
    // A question that was passed over reads as passed over rather than blank.
    expect(summary.querySelector('.is-skipped')?.textContent).toBe('Skipped')
  })

  it('names a single answered question by its header, and says when it was cancelled', async () => {
    const question = {
      id: 'scope',
      header: 'Delete scope',
      question: 'What should be deleted?',
      options: [{ label: 'Everything, all of it' }, { label: 'Only drafts' }]
    }
    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={{
            id: 'question-4',
            kind: 'question',
            status: 'resolved',
            request: { questions: [question] },
            response: { scope: 'Everything, all of it' }
          }}
          onResolve={vi.fn()}
        />
      )
    )
    const row = (): HTMLButtonElement =>
      container.querySelector('.agent-question-answered') as HTMLButtonElement
    expect(row().getAttribute('aria-label')).toBe('Delete scope, answered: Everything, all of it')
    expect(row().querySelector('.agent-question-answered-label')?.textContent).toBe('Delete scope')
    expect(row().querySelector('.agent-question-answered-value')?.textContent).toBe(
      'Everything, all of it'
    )

    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={{
            id: 'question-5',
            kind: 'question',
            status: 'cancelled',
            request: { questions: [question] }
          }}
          onResolve={vi.fn()}
        />
      )
    )
    expect(row().getAttribute('aria-label')).toBe('Delete scope, cancelled')
    await act(async () => row().click())
    expect(container.querySelector('.agent-question-summary dd')?.textContent).toBe('Not answered')
  })

  it('answers from the keyboard: arrows move between choices and a digit picks one', async () => {
    const resolve = vi.fn()
    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={{
            id: 'question-6',
            kind: 'question',
            status: 'pending',
            request: {
              questions: [
                {
                  id: 'size',
                  question: 'Which size?',
                  options: [{ label: 'Small' }, { label: 'Medium' }, { label: 'Large' }]
                }
              ]
            }
          }}
          onResolve={resolve}
        />
      )
    )
    const options = [...container.querySelectorAll<HTMLButtonElement>('.agent-question-option')]
    const input = container.querySelector('input') as HTMLInputElement
    const press = (target: Element, key: string): void => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    }
    // Nothing else had focus, so the first choice takes it.
    expect(document.activeElement).toBe(options[0])
    expect(
      options.map((option) => option.querySelector('.agent-question-mark')?.textContent)
    ).toEqual(['1', '2', '3'])

    await act(async () => press(options[0], 'ArrowDown'))
    expect(document.activeElement).toBe(options[1])
    await act(async () => press(options[1], 'ArrowUp'))
    await act(async () => press(options[0], 'ArrowUp'))
    expect(document.activeElement).toBe(input)
    // In the field a digit is text, and ArrowUp returns to the choices.
    await act(async () => press(input, '2'))
    expect(resolve).not.toHaveBeenCalled()
    await act(async () => press(input, 'ArrowUp'))
    expect(document.activeElement).toBe(options[2])

    await act(async () => press(options[2], '2'))
    expect(resolve).toHaveBeenCalledWith('question-6', { size: 'Medium' })
  })

  it('leaves focus where the user is typing when a question arrives', async () => {
    const draft = document.createElement('textarea')
    document.body.appendChild(draft)
    draft.focus()
    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={{
            id: 'question-7',
            kind: 'question',
            status: 'pending',
            request: { questions: [{ id: 'name', question: 'Name it' }] }
          }}
          onResolve={vi.fn()}
        />
      )
    )
    expect(document.activeElement).toBe(draft)
    draft.remove()
  })

  it('opens the exact suspended browser session and resumes after verification clears', async () => {
    const resolve = vi.fn()
    beginBrowserHumanTakeover.mockResolvedValue({
      active: true,
      url: 'https://example.test/challenge',
      title: 'Security check',
      humanVerificationRequired: true,
      message: 'Press and hold to continue.'
    })
    completeBrowserHumanTakeover.mockResolvedValue({
      active: false,
      url: 'https://example.test/complete',
      title: 'Example',
      humanVerificationRequired: false
    })

    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={{
            id: 'takeover-1',
            kind: 'question',
            status: 'pending',
            request: {
              intent: 'browser_takeover',
              reason: 'The site requires a human verification step.',
              conversationId: 'chat-1'
            }
          }}
          onResolve={resolve}
        />
      )
    )

    const button = (label: string): HTMLButtonElement =>
      [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label))!
    await act(async () => button('Take control').click())
    expect(beginBrowserHumanTakeover).toHaveBeenCalledWith('takeover-1')
    expect(container.textContent).toContain('https://example.test/challenge')

    await act(async () => button('I’ve finished — resume').click())
    expect(completeBrowserHumanTakeover).toHaveBeenCalledWith('takeover-1')
    expect(resolve).toHaveBeenCalledWith('takeover-1', { completed: true })
  })

  it('keeps the run suspended when human verification is still visible', async () => {
    const resolve = vi.fn()
    beginBrowserHumanTakeover.mockResolvedValue({
      active: true,
      url: 'https://example.test/challenge',
      title: 'Security check',
      humanVerificationRequired: true
    })
    completeBrowserHumanTakeover.mockResolvedValue({
      active: false,
      url: 'https://example.test/challenge',
      title: 'Security check',
      humanVerificationRequired: true,
      message: 'Verification is still visible.'
    })

    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={{
            id: 'takeover-2',
            kind: 'question',
            status: 'pending',
            request: { intent: 'browser_takeover', reason: 'Please complete the site check.' }
          }}
          onResolve={resolve}
        />
      )
    )

    const button = (label: string): HTMLButtonElement =>
      [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label))!
    await act(async () => button('Take control').click())
    await act(async () => button('I’ve finished — resume').click())

    expect(container.textContent).toContain('Verification is still visible.')
    expect(container.textContent).toContain('Take control')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('offers the most common approval first and a chat-wide one only for a scoped request', async () => {
    const onResolve = vi.fn(async () => undefined)
    const permission = (id: string, chatScope?: string) => ({
      id,
      kind: 'permission' as const,
      status: 'pending' as const,
      request: { title: 'Run npm test?', ...(chatScope ? { chatScope } : {}) }
    })
    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={permission('scoped', 'this exact command')}
          onResolve={onResolve}
        />
      )
    )
    const labels = [...container.querySelectorAll('button')].map((button) => button.textContent)
    expect(labels).toEqual(['Allow once', 'Allow for this chat', 'Deny', 'Deny and stop'])
    const chat = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Allow for this chat'
    )!
    expect(chat.title).toContain('this exact command')
    await act(async () => chat.click())
    expect(onResolve).toHaveBeenCalledWith('scoped', { approved: true, decision: 'allow_chat' })
    expect(container.textContent).toContain('Allowed for this chat')

    await act(async () =>
      root.render(<AgentInteractionCard interaction={permission('plain')} onResolve={onResolve} />)
    )
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Allow once',
      'Deny',
      'Deny and stop'
    ])
    const stop = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Deny and stop'
    )!
    await act(async () => stop.click())
    expect(onResolve).toHaveBeenLastCalledWith('plain', { approved: false, decision: 'deny_stop' })
    expect(container.textContent).toContain('Denied and stopped')
  })

  it('shows the recorded decision, reading older responses as allow once or deny', async () => {
    const resolved = (response: Record<string, unknown>) => ({
      id: `permission-${JSON.stringify(response)}`,
      kind: 'permission' as const,
      status: 'resolved' as const,
      request: { title: 'Edit file?' },
      response
    })
    for (const [response, label] of [
      [{ approved: true }, 'Allowed once'],
      [{ approved: false }, 'Denied'],
      [{ approved: true, decision: 'allow_chat' }, 'Allowed for this chat'],
      [{ approved: false, decision: 'deny_stop' }, 'Denied and stopped']
    ] as const) {
      await act(async () =>
        root.render(<AgentInteractionCard interaction={resolved(response)} onResolve={vi.fn()} />)
      )
      expect(container.querySelector('.agent-interaction-status')?.textContent).toBe(label)
    }
  })
})
