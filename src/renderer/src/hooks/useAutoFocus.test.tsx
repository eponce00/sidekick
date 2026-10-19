// @vitest-environment jsdom

import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutoFocus } from './useAutoFocus'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function Composer({
  loading,
  modal,
  conversation = 'conversation',
  children
}: {
  loading: boolean
  modal: boolean
  conversation?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useAutoFocus(inputRef, loading, false, conversation)
  return (
    <>
      <textarea ref={inputRef} aria-label="Composer" />
      {modal && (
        <div role="dialog" aria-modal="true">
          <input aria-label="API key" autoFocus />
        </div>
      )}
      {children}
    </>
  )
}

describe('useAutoFocus', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('focuses the composer when a reply finishes', async () => {
    await act(async () => root.render(<Composer loading={true} modal={false} />))
    await act(async () => root.render(<Composer loading={false} modal={false} />))
    await act(async () => vi.advanceTimersByTime(200))
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Composer')
  })

  it('leaves focus in an open dialog when a reply finishes or the window regains focus', async () => {
    await act(async () => root.render(<Composer loading={true} modal={true} />))
    const key = container.querySelector<HTMLInputElement>('[aria-label="API key"]')!
    key.focus()
    await act(async () => root.render(<Composer loading={false} modal={true} />))
    await act(async () => vi.advanceTimersByTime(500))
    window.dispatchEvent(new Event('focus'))
    expect(document.activeElement).toBe(key)
  })

  it('leaves focus in a field typed in elsewhere when the chat changes, a reply finishes or the window regains focus', async () => {
    const elsewhere = (
      <>
        <input aria-label="Browser address" />
        {/* The terminal takes keys through a textarea, as xterm does. */}
        <textarea aria-label="Terminal input" />
      </>
    )
    await act(async () =>
      root.render(
        <Composer loading={true} modal={false} conversation="first">
          {elsewhere}
        </Composer>
      )
    )
    const address = container.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!
    address.focus()
    // A new chat starts its timer as the user reaches the address bar.
    await act(async () =>
      root.render(
        <Composer loading={false} modal={false} conversation="second">
          {elsewhere}
        </Composer>
      )
    )
    await act(async () => vi.advanceTimersByTime(500))
    window.dispatchEvent(new Event('focus'))
    expect(document.activeElement).toBe(address)

    const terminal = container.querySelector<HTMLElement>('[aria-label="Terminal input"]')!
    terminal.focus()
    await act(async () =>
      root.render(
        <Composer loading={true} modal={false} conversation="second">
          {elsewhere}
        </Composer>
      )
    )
    await act(async () =>
      root.render(
        <Composer loading={false} modal={false} conversation="second">
          {elsewhere}
        </Composer>
      )
    )
    await act(async () => vi.advanceTimersByTime(500))
    expect(document.activeElement).toBe(terminal)
  })

  it('still takes focus from a button or a field that is no longer shown', async () => {
    await act(async () =>
      root.render(
        <Composer loading={true} modal={false}>
          <button type="button">New chat</button>
          <div className="previous-chat">
            <textarea aria-label="Previous composer" />
          </div>
        </Composer>
      )
    )
    container.querySelector<HTMLButtonElement>('button')!.focus()
    await act(async () =>
      root.render(
        <Composer loading={false} modal={false}>
          <button type="button">New chat</button>
          <div className="previous-chat">
            <textarea aria-label="Previous composer" />
          </div>
        </Composer>
      )
    )
    await act(async () => vi.advanceTimersByTime(200))
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Composer')

    container.querySelector<HTMLTextAreaElement>('[aria-label="Previous composer"]')!.focus()
    container.querySelector('.previous-chat')!.setAttribute('hidden', '')
    window.dispatchEvent(new Event('focus'))
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Composer')
  })
})
