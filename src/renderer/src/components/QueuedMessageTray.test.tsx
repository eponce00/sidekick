// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingRunMessageItem } from '../hooks/useConversationRun'
import { QueuedMessageTray } from './QueuedMessageTray'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const queuedMessages: PendingRunMessageItem[] = [
  { id: 'queued-1', content: 'Add validation for the import flow', mode: 'conversation' },
  { id: 'queued-2', content: 'Then update the release notes', mode: 'plan' }
]

describe('QueuedMessageTray', () => {
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

  function renderTray(overrides?: {
    pivotMessage?: PendingRunMessageItem | null
    onUpdate?: (id: string, content: string) => boolean
    onRemove?: (id: string) => void
    onMove?: (id: string, toIndex: number) => void
    onSteer?: (id: string) => void
  }) {
    const callbacks = {
      onUpdate: overrides?.onUpdate ?? vi.fn(() => true),
      onRemove: overrides?.onRemove ?? vi.fn(),
      onMove: overrides?.onMove ?? vi.fn(),
      onSteer: overrides?.onSteer ?? vi.fn()
    }
    act(() => {
      root.render(
        <QueuedMessageTray
          pivotMessage={overrides?.pivotMessage ?? null}
          queuedMessages={queuedMessages}
          {...callbacks}
        />
      )
    })
    return callbacks
  }

  it('renders compact queue rows and exposes steer, edit, and remove actions', () => {
    const callbacks = renderTray()

    expect(container.querySelectorAll('.queued-message-card')).toHaveLength(2)
    expect(container.textContent).toContain('Add validation for the import flow')
    expect(container.querySelector('[aria-label="Queued messages"]')).not.toBeNull()

    act(() => {
      ;(container.querySelector('[aria-label="Steer with queued message now"]') as HTMLElement).click()
      ;(container.querySelector('[aria-label="Remove queued message"]') as HTMLElement).click()
    })

    expect(callbacks.onSteer).toHaveBeenCalledWith('queued-1')
    expect(callbacks.onRemove).toHaveBeenCalledWith('queued-1')
  })

  it('edits a queued message in place and supports save and discard', () => {
    const onUpdate = vi.fn(() => true)
    renderTray({ onUpdate })

    act(() => {
      ;(container.querySelector('[aria-label="Edit queued message"]') as HTMLElement).click()
    })
    const editor = container.querySelector(
      'textarea[aria-label="Edit queued message"]'
    ) as HTMLTextAreaElement
    expect(editor).not.toBeNull()

    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set
    act(() => {
      valueSetter?.call(editor, 'Add validation and integration coverage')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      ;(container.querySelector('[aria-label="Save queued message edit"]') as HTMLElement).click()
    })

    expect(onUpdate).toHaveBeenCalledWith('queued-1', 'Add validation and integration coverage')
    expect(container.querySelector('textarea[aria-label="Edit queued message"]')).toBeNull()

    act(() => {
      ;(container.querySelector('[aria-label="Edit queued message"]') as HTMLElement).click()
    })
    act(() => {
      ;(
        container.querySelector('[aria-label="Discard queued message edit"]') as HTMLElement
      ).click()
    })
    expect(onUpdate).toHaveBeenCalledOnce()
  })

  it('connects drag and drop to stable queue identities', () => {
    const onMove = vi.fn()
    renderTray({ onMove })
    const [first, second] = Array.from(
      container.querySelectorAll<HTMLElement>('.queued-message-card')
    )
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: vi.fn()
    }
    const dispatchDrag = (target: HTMLElement, type: string): void => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      target.dispatchEvent(event)
    }

    act(() =>
      dispatchDrag(first.querySelector<HTMLElement>('.queued-message-handle')!, 'dragstart')
    )
    act(() => dispatchDrag(second, 'dragover'))
    act(() => dispatchDrag(second, 'drop'))

    expect(onMove).toHaveBeenCalledWith('queued-1', 1)
  })

  it('shows a steering message without another steer action', () => {
    renderTray({
      pivotMessage: { id: 'pivot-1', content: 'Change direction now', mode: 'conversation' }
    })

    expect(container.textContent).toContain('Steering')
    expect(container.querySelectorAll('[aria-label="Steer with queued message now"]')).toHaveLength(2)
    expect(
      container
        .querySelector('[data-pending-message-id="pivot-1"]')
        ?.querySelector('[aria-label="Steer with queued message now"]')
    ).toBeNull()
  })
})
