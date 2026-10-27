// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageMarkdown } from './MessageMarkdown'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TABLE = [
  '| Name | Notes |',
  '| :--- | ---: |',
  '| Ollama | A long note that wraps over several lines in a narrow chat. |'
].join('\n')

// jsdom has no layout: a header cell is as wide as its text, on one line while the table is
// measured and squeezed to its longest word otherwise.
const NATURAL: Record<string, number> = { Name: 90, Notes: 600 }

describe('MarkdownTable', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      const measuring = this.closest('table')?.classList.contains('is-measuring')
      const natural = NATURAL[this.textContent ?? ''] ?? 10
      const width = this.tagName === 'TH' ? (measuring ? natural : 60) : 10
      return { width, height: 20, left: 0, right: width, top: 0, bottom: 20 } as DOMRect
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  const headers = (): HTMLTableCellElement[] => [...container.querySelectorAll('th')]

  it('keeps each column at least as wide as its content on one line, up to a limit', async () => {
    await act(async () => root.render(<MessageMarkdown content={TABLE} />))
    // Name fits on one line; Notes would be 600 px, so it stops at 16 em of 13 px.
    expect(headers().map((cell) => cell.style.minWidth)).toEqual(['90px', '208px'])
    // The column's own alignment is kept.
    expect(headers()[1].style.textAlign).toBe('right')
  })

  it('resizes a column from its header’s edge, and fits it to its content again', async () => {
    await act(async () => root.render(<MessageMarkdown content={TABLE} />))
    const edge = headers()[0].querySelector<HTMLElement>('.markdown-table-resize')!

    await act(async () => {
      edge.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100 })
      )
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 140 }))
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 140 }))
    })
    const table = container.querySelector('table')!
    expect([...table.querySelectorAll('col')].map((col) => col.style.width)).toEqual([
      '100px',
      '60px'
    ])
    expect(table.classList.contains('is-sized')).toBe(true)
    expect(table.style.width).toBe('160px')

    // Never narrower than a usable column.
    await act(async () => {
      edge.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100 })
      )
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: -400 }))
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: -400 }))
    })
    expect(table.querySelector('col')?.style.width).toBe('48px')

    await act(async () => edge.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(table.querySelector('colgroup')).toBeNull()
    expect(table.classList.contains('is-sized')).toBe(false)
  })
})
