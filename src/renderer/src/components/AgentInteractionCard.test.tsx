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

  beforeEach(() => {
    Object.defineProperty(window, 'api', { configurable: true, value: { agentRuns: {} } })
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

  it('shows no card for a human check an older chat asked for', async () => {
    // Checks are cleared in the Browser panel now; this card's buttons no longer do anything.
    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={{
            id: 'takeover-1',
            kind: 'question',
            status: 'resolved',
            request: { intent: 'browser_takeover', reason: 'The site requires a check.' },
            response: { completed: true }
          }}
          onResolve={vi.fn()}
        />
      )
    )
    expect(container.innerHTML).toBe('')
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
    const button = (label: string): HTMLButtonElement | undefined =>
      [...container.querySelectorAll('button')].find((item) => item.textContent === label)
    expect(button('Allow for this chat')!.title).toContain('this exact command')
    await act(async () => button('Allow for this chat')!.click())
    expect(onResolve).toHaveBeenCalledWith('scoped', { approved: true, decision: 'allow_chat' })

    await act(async () =>
      root.render(<AgentInteractionCard interaction={permission('plain')} onResolve={onResolve} />)
    )
    expect(button('Allow for this chat')).toBeUndefined()
    await act(async () => button('Deny and stop')!.click())
    expect(onResolve).toHaveBeenLastCalledWith('plain', { approved: false, decision: 'deny_stop' })
  })

  it('shows a proposed settings change as before and after, ignoring malformed previews', async () => {
    const permission = (id: string, preview: unknown) => ({
      id,
      kind: 'permission' as const,
      status: 'pending' as const,
      request: { title: 'Change a SideKick setting?', preview }
    })
    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={permission('diff', {
            summary: 'Let the agent search the web.',
            changes: [{ label: 'webSearchEnabled', before: 'false', after: 'true' }]
          })}
          onResolve={vi.fn()}
        />
      )
    )
    expect(container.querySelector('dt')?.textContent).toBe('webSearchEnabled')
    expect(container.querySelector('del')?.textContent).toBe('false')
    expect(container.querySelector('ins')?.textContent).toBe('true')

    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={permission('bad', { changes: [{ label: 1, before: {}, after: null }] })}
          onResolve={vi.fn()}
        />
      )
    )
    expect(container.querySelector('.agent-interaction-preview')).toBeNull()
  })

  it('shows where a credential goes as plain facts, without a before and after', async () => {
    await act(async () =>
      root.render(
        <AgentInteractionCard
          interaction={{
            id: 'credential',
            kind: 'permission',
            status: 'pending',
            request: {
              title: 'Use partner-center: GET api.example.com',
              chatScope: 'partner-center with api.example.com',
              preview: {
                summary: 'SideKick adds partner-center to this request itself.',
                changes: [],
                facts: [
                  { label: 'Credential', value: 'partner-center' },
                  { label: 'Sent to', value: 'https://api.example.com/v1' },
                  { label: 7, value: 'malformed' }
                ]
              }
            }
          }}
          onResolve={vi.fn()}
        />
      )
    )
    const facts = Array.from(container.querySelectorAll('.agent-interaction-fact'))
    expect(facts.map((fact) => fact.textContent)).toEqual([
      'Credentialpartner-center',
      'Sent tohttps://api.example.com/v1'
    ])
    expect(container.querySelector('del')).toBeNull()
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
