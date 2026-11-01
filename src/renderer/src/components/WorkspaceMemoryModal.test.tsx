// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceMemoryModal } from './WorkspaceMemoryModal'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
    textarea,
    value
  )
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('WorkspaceMemoryModal', () => {
  let container: HTMLDivElement
  let root: Root
  let save: ReturnType<typeof vi.fn>

  beforeEach(() => {
    save = vi.fn(async (_folder: string, content: string) => ({
      ok: true,
      content: content.trim(),
      updatedAt: Date.now()
    }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { memory: { save } }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.querySelector('.workspace-memory-backdrop')?.remove()
    container.remove()
  })

  it('saves edited notes for the open project only once they changed', async () => {
    const onClose = vi.fn()
    const onSaved = vi.fn()
    await act(async () =>
      root.render(
        <WorkspaceMemoryModal
          isOpen
          workspaceFolder={'C:\\projects\\SideKick'}
          initialContent="Existing decision"
          onClose={onClose}
          onSaved={onSaved}
        />
      )
    )

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const saveButton = [...dialog.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Save notes')
    ) as HTMLButtonElement
    expect(saveButton.disabled).toBe(true)

    await act(async () =>
      setTextareaValue(dialog.querySelector('textarea')!, 'Existing decision\nUse compact cards')
    )
    expect(saveButton.disabled).toBe(false)

    await act(async () => saveButton.click())
    expect(save).toHaveBeenCalledWith(
      'C:\\projects\\SideKick',
      'Existing decision\nUse compact cards'
    )
    expect(onSaved).toHaveBeenCalledWith('Existing decision\nUse compact cards')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('resets the form when the project changes even if both projects have the same notes', async () => {
    const onClose = vi.fn()
    const onSaved = vi.fn()
    await act(async () =>
      root.render(
        <WorkspaceMemoryModal
          isOpen
          workspaceFolder={'C:\\projects\\First'}
          initialContent="Shared text"
          onClose={onClose}
          onSaved={onSaved}
        />
      )
    )
    const firstTextarea = document.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => setTextareaValue(firstTextarea, 'Unsaved first-project edit'))

    await act(async () =>
      root.render(
        <WorkspaceMemoryModal
          isOpen
          workspaceFolder={'C:\\projects\\Second'}
          initialContent="Shared text"
          onClose={onClose}
          onSaved={onSaved}
        />
      )
    )

    const secondTextarea = document.querySelector('textarea') as HTMLTextAreaElement
    expect(secondTextarea).not.toBe(firstTextarea)
    expect(secondTextarea.value).toBe('Shared text')
  })
})
