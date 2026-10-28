// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReasoningLevel } from '../../../shared/reasoning'
import type { PinnedModel } from '../types/models.types'
import { ChatModelPicker } from './ChatModelPicker'
import { effortStops } from '../utils/effortStops'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const MODELS = [
  { id: 'a:sonnet', name: 'Claude Sonnet', provider: 'anthropic', providerKind: 'anthropic' },
  { id: 'b:qwen', name: 'Qwen 3 8B', provider: 'lmstudio', providerKind: 'lmstudio' }
] as PinnedModel[]

describe('effortStops', () => {
  it('orders a model’s levels from the least reasoning to the most', () => {
    expect(effortStops(['xhigh', 'off', 'minimal', 'low', 'medium', 'high'])).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    expect(effortStops(['on', 'off'])).toEqual(['off', 'on'])
  })
})

describe('ChatModelPicker with reasoning', () => {
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

  function Picker({
    levels,
    initial,
    onModelChange = vi.fn()
  }: {
    levels: ReasoningLevel[]
    initial: ReasoningLevel
    onModelChange?: (id: string) => void
  }) {
    const [level, setLevel] = useState(initial)
    const [open, setOpen] = useState(false)
    return (
      <ChatModelPicker
        selectedModelId="a:sonnet"
        models={MODELS}
        isOpen={open}
        onToggle={() => setOpen((current) => !current)}
        onModelChange={onModelChange}
        onManageModels={vi.fn()}
        reasoning={{ options: { levels, initial }, level, onChange: setLevel }}
      />
    )
  }

  const chip = (): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>('.model-selector-inline')!
  const slider = (): HTMLElement => container.querySelector<HTMLElement>('[role="slider"]')!

  it('steps the effort with the arrow keys and resets to the starting level', async () => {
    await act(async () =>
      root.render(<Picker levels={['off', 'low', 'medium', 'high', 'max']} initial="off" />)
    )
    await act(async () => chip().click())
    for (let step = 0; step < 3; step++)
      await act(async () =>
        slider().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      )
    expect(slider().getAttribute('aria-valuetext')).toBe('High')
    await act(async () =>
      slider().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    )
    expect(container.querySelector('.effort-card-level')?.textContent).toBe('Max')
    await act(async () => container.querySelector<HTMLButtonElement>('.effort-card-reset')!.click())
    expect(container.querySelector('.effort-card-level')?.textContent).toBe('Off')
  })
})
