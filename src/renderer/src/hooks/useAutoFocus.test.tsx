// @vitest-environment jsdom

import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutoFocus } from './useAutoFocus'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function Composer({ loading, modal }: { loading: boolean; modal: boolean }): React.JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useAutoFocus(inputRef, loading, false, 'conversation')
  return (
    <>
      <textarea ref={inputRef} aria-label="Composer" />
      {modal && (
        <div role="dialog" aria-modal="true">
          <input aria-label="API key" autoFocus />
        </div>
      )}
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
})
