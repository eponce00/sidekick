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

  it('renders compact queue rows and exposes steer, edit, and remove actions', () => {
    const callbacks = renderTray()

    expect(container.querySelectorAll('.queued-message-card')).toHaveLength(2)
    expect(container.textContent).toContain('Add validation for the import flow')
    expect(container.querySelector('[aria-label="Queued messages"]')).not.toBeNull()

    act(() => {
      ;(
        container.querySelector('[aria-label="Steer with queued message now"]') as HTMLElement
      ).click()
      ;(container.querySelector('[aria-label="Remove queued message"]') as HTMLElement).click()
    })

    expect(callbacks.onSteer).toHaveBeenCalledWith('queued-1')
    expect(callbacks.onRemove).toHaveBeenCalledWith('queued-1')
  })

  it('edits in the message box, from the message text, as a sent message is edited', () => {
    const onEdit = vi.fn()
    renderTray({ onEdit })
    act(() => {
      ;(container.querySelector('[aria-label="Edit queued message"]') as HTMLElement).click()
    })
    const [message, source] = onEdit.mock.calls[0]
    expect(message).toMatchObject({ id: 'queued-1' })
    expect((source as HTMLElement).classList.contains('queued-message-text')).toBe(true)
    // No second text box opens inside the tray.
    expect(container.querySelector('textarea')).toBeNull()

    renderTray({ onEdit, editingId: 'queued-1' })
    expect(
      container
        .querySelector('[data-pending-message-id="queued-1"]')
        ?.classList.contains('is-editing')
    ).toBe(true)
  })

  it('opens a message’s actions with a tap on touch screens, keeping only Steer on the row', () => {
    const onOpenActions = vi.fn()
    const callbacks = renderTray({ onOpenActions })
    expect(container.querySelector('[aria-label="Edit queued message"]')).toBeNull()
    expect(container.querySelector('[aria-label="Remove queued message"]')).toBeNull()
    act(() => {
      ;(
        container.querySelector(
          '[aria-label="Actions for Then update the release notes"]'
        ) as HTMLElement
      ).click()
    })
    expect(onOpenActions).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'queued-2' }),
      expect.any(HTMLElement)
    )
    act(() => {
      ;(
        container.querySelector('[aria-label="Steer with queued message now"]') as HTMLElement
      ).click()
    })
    expect(callbacks.onSteer).toHaveBeenCalledWith('queued-1')
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
