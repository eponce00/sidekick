// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ContextIndicator from './ContextIndicator'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('context indicator', () => {
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

  const render = (currentTokens: number): Promise<void> =>
    act(async () =>
      root.render(
        <ContextIndicator currentTokens={currentTokens} maxTokens={100_000} selectedModel="" />
      )
    )

  it('describes the focused ring by its tooltip, and keeps it open while focused', async () => {
    await render(20_000)
    const ring = container.querySelector<HTMLElement>('[role="img"]')!
    await act(async () => ring.focus())
    const describedBy = ring.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toContain('Auto-compact')
    const wrapper = container.querySelector('.context-indicator')!
    await act(async () => {
      wrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      wrapper.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    })
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull()
  })

  it('draws no numeral once the window is full', async () => {
    await render(120_000)
    expect(container.querySelector('.context-ring text')).toBeNull()
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('100.0%')
  })
})
