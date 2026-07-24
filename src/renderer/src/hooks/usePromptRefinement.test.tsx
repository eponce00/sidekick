// @vitest-environment jsdom

import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptRefinementResult } from '../services/providers/promptRefinement'
import { usePromptRefinement } from './usePromptRefinement'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Controller = ReturnType<typeof usePromptRefinement>

const config = {
  model: { provider: 'ollama' as const, model: 'test-model' },
  context: { surface: 'conversation' as const }
}

describe('usePromptRefinement', () => {
  let root: Root
  let controller: Controller
  let renderedValue = ''
  let refine: ReturnType<
    typeof vi.fn<(draft: string) => Promise<PromptRefinementResult>>
  >

  function Harness(): null {
    const [value, setValue] = useState('make a website about cuba')
    const current = usePromptRefinement({ value, onChange: setValue, config, refine })
    useEffect(() => {
      controller = current
      renderedValue = value
    }, [current, value])
    return null
  }

  beforeEach(async () => {
    root = createRoot(document.createElement('div'))
    refine = vi.fn(async () => ({ ok: true, text: 'Build and validate a Cuba website.' }))
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
  })

  it('replaces the draft without sending and restores it with Undo', async () => {
    await act(async () => controller.sharpen())

    expect(renderedValue).toBe('Build and validate a Cuba website.')
    expect(controller.status).toBe('success')

    act(() => controller.undo())
    expect(renderedValue).toBe('make a website about cuba')
    expect(controller.status).toBe('idle')
  })

  it('never lets a late result overwrite text entered while refinement is running', async () => {
    let resolveRefinement!: (result: PromptRefinementResult) => void
    refine.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefinement = resolve
        })
    )

    let pending!: Promise<void>
    await act(async () => {
      pending = controller.sharpen()
      await Promise.resolve()
    })
    act(() => controller.handleChange('a newer draft written by the user'))
    await act(async () => {
      resolveRefinement({ ok: true, text: 'Stale model response' })
      await pending
    })

    expect(renderedValue).toBe('a newer draft written by the user')
    expect(controller.status).toBe('idle')
  })

  it('keeps provider failures non-destructive and retryable', async () => {
    refine.mockResolvedValueOnce({ ok: false, error: 'Provider timed out' })

    await act(async () => controller.sharpen())

    expect(renderedValue).toBe('make a website about cuba')
    expect(controller.status).toBe('error')
    expect(controller.error).toBe('Provider timed out')
    expect(controller.canRefine).toBe(true)
  })
})
