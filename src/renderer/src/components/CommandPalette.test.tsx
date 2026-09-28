// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CommandPalette from './CommandPalette'
import type { CommandPaletteItem } from '../utils/commandPalette'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('CommandPalette', () => {
  let container: HTMLDivElement
  let root: Root
  let newChat: ReturnType<typeof vi.fn<() => void>>
  let openChat: ReturnType<typeof vi.fn<() => void>>
  let items: CommandPaletteItem[]

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    newChat = vi.fn<() => void>()
    openChat = vi.fn<() => void>()
    items = [
      { id: 'new', group: 'actions', title: 'New chat', shortcut: 'Ctrl+N', run: newChat },
      { id: 'busy', group: 'actions', title: 'Unavailable', disabled: true, run: vi.fn() },
      {
        id: 'chat',
        group: 'conversations',
        title: 'Release notes',
        recency: 2,
        run: openChat
      }
    ]
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const input = (): HTMLInputElement =>
    container.querySelector('input[role="combobox"]') as HTMLInputElement
  const selected = (): string | null | undefined =>
    container.querySelector('[role="option"][aria-selected="true"]')?.textContent
  const press = (key: string): void => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  }
  const type = (value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('renders nothing while closed', async () => {
    await act(async () =>
      root.render(<CommandPalette isOpen={false} items={items} onClose={vi.fn()} />)
    )
    expect(container.innerHTML).toBe('')
  })

  it('moves with the arrow keys past disabled rows and runs the choice on Enter', async () => {
    const onClose = vi.fn()
    await act(async () => root.render(<CommandPalette isOpen items={items} onClose={onClose} />))
    expect(selected()).toContain('New chat')
    expect(selected()).toContain('Ctrl+N')

    await act(async () => press('ArrowDown'))
    expect(selected()).toContain('Release notes')
    await act(async () => press('ArrowDown'))
    expect(selected()).toContain('New chat')
    await act(async () => press('ArrowUp'))
    await act(async () => press('Enter'))

    expect(onClose).toHaveBeenCalledOnce()
    expect(openChat).toHaveBeenCalledOnce()
    expect(newChat).not.toHaveBeenCalled()
  })

  it('filters as the user types and says when nothing matches', async () => {
    await act(async () => root.render(<CommandPalette isOpen items={items} onClose={vi.fn()} />))
    await act(async () => type('relnot'))
    expect(selected()).toContain('Release notes')
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)

    await act(async () => type('zzz'))
    expect(container.textContent).toContain('No matches')
  })

  it('closes on Escape and on a click outside', async () => {
    const onClose = vi.fn()
    await act(async () => root.render(<CommandPalette isOpen items={items} onClose={onClose} />))
    await act(async () => press('Escape'))
    expect(onClose).toHaveBeenCalledTimes(1)
    const overlay = container.querySelector('.command-palette-overlay') as HTMLElement
    await act(async () => overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
