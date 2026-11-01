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
    onEdit?: (message: PendingRunMessageItem, source: HTMLElement | null) => void
    onRemove?: (id: string) => void
    onMove?: (id: string, toIndex: number) => void
    onSteer?: (id: string) => void
    onOpenActions?: (message: PendingRunMessageItem, source: HTMLElement | null) => void
    editingId?: string | null
  }) {
    const callbacks = {
      onEdit: overrides?.onEdit ?? vi.fn(),
      onRemove: overrides?.onRemove ?? vi.fn(),
      onMove: overrides?.onMove ?? vi.fn(),
      onSteer: overrides?.onSteer ?? vi.fn()
    }
    act(() => {
      root.render(
        <QueuedMessageTray
          pivotMessage={overrides?.pivotMessage ?? null}
          queuedMessages={queuedMessages}
          onOpenActions={overrides?.onOpenActions}
          editingId={overrides?.editingId}
          {...callbacks}
        />
      )
    })
    return callbacks
  }

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

    expect(container.querySelectorAll('[aria-label="Steer with queued message now"]')).toHaveLength(
      2
    )
    expect(
      container
        .querySelector('[data-pending-message-id="pivot-1"]')
        ?.querySelector('[aria-label="Steer with queued message now"]')
    ).toBeNull()
  })
})
