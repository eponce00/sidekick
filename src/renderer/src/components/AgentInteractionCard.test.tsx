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
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('pages through multi-select questions and submits selected values', async () => {
    const resolve = vi.fn()
    await act(async () => root.render(
      <AgentInteractionCard interaction={{
        id: 'question-1', kind: 'question', status: 'pending', request: { questions: [
          { id: 'features', header: 'Scope', question: 'Which features?', multiSelect: true, options: [
            { label: 'Files', description: 'File tools', recommended: true },
            { label: 'Web', description: 'Web tools' }
          ] },
          { id: 'format', question: 'Which format?', options: [{ label: 'Compact' }, { label: 'Detailed' }] }
        ] }
      }} onResolve={resolve} />
    ))

    const option = (name: string): HTMLButtonElement => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(name))!
    await act(async () => { option('Files').click(); option('Web').click() })
    expect(option('Files').getAttribute('aria-pressed')).toBe('true')
    await act(async () => option('Next').click())
    expect(container.textContent).toContain('Question 2 of 2')
    await act(async () => option('Compact').click())
    await act(async () => option('Send answers').click())
    expect(resolve).toHaveBeenCalledWith('question-1', { features: ['Files', 'Web'], format: 'Compact' })
  })

  it('supports custom answers, back navigation, skip, and cancellation', async () => {
    const resolve = vi.fn()
    await act(async () => root.render(
      <AgentInteractionCard interaction={{
        id: 'question-2', kind: 'question', status: 'pending', request: { questions: [
          { id: 'name', question: 'Name it' },
          { id: 'color', question: 'Choose a color', options: [{ label: 'Blue' }, { label: 'Green' }] }
        ] }
      }} onResolve={resolve} />
    ))
    const input = container.querySelector('input') as HTMLInputElement
    await act(async () => setInputValue(input, 'Sidekick'))
    const button = (label: string): HTMLButtonElement => [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label))!
    await act(async () => button('Next').click())
    await act(async () => button('Back').click())
    await act(async () => button('Next').click())
    await act(async () => button('Skip').click())
    expect(resolve).toHaveBeenCalledWith('question-2', { name: 'Sidekick' })

    resolve.mockClear()
    await act(async () => button('Cancel').click())
    expect(resolve).toHaveBeenCalledWith('question-2', {}, true)
  })

  it('collects an other answer and exposes resolved state', async () => {
    const resolve = vi.fn()
    await act(async () => root.render(
      <AgentInteractionCard interaction={{
        id: 'question-3', kind: 'question', status: 'pending', request: { questions: [
          { id: 'editor', question: 'Which editor?', options: [{ label: 'VS Code' }, { label: 'Cursor' }] }
        ] }
      }} onResolve={resolve} />
    ))
    const other = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Something else'))!
    await act(async () => other.click())
    const input = container.querySelector('input') as HTMLInputElement
    await act(async () => setInputValue(input, 'Zed'))
    const send = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Send answers'))!
    await act(async () => send.click())
    expect(resolve).toHaveBeenCalledWith('question-3', { editor: 'Zed' })

    await act(async () => root.render(
      <AgentInteractionCard interaction={{ id: 'question-3', kind: 'question', status: 'resolved', request: { questions: [] }, response: { editor: 'Zed' } }} onResolve={resolve} />
    ))
    expect(container.textContent).toContain('Answered')
  })
})
