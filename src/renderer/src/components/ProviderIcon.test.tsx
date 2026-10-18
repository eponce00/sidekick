// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { ProviderIcon } from './ProviderIcon'
import type { ProviderIconKind } from '../utils/providerIconKinds'

const KINDS: ProviderIconKind[] = [
  'ollama',
  'ollama-cloud',
  'openrouter',
  'anthropic',
  'litellm',
  'lmstudio',
  'openai-compatible',
  'llamacpp'
]

async function render(provider: ProviderIconKind, size?: number): Promise<HTMLElement> {
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => root.render(<ProviderIcon provider={provider} size={size} />))
  return container
}

it('draws every provider as one filled set in the current text colour', async () => {
  const marks = new Set<string>()
  for (const provider of KINDS) {
    const container = await render(provider)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.getAttribute('fill')).toBe('currentColor')
    expect(svg.getAttribute('width')).toBe('14')

    const shapes = [...svg.querySelectorAll('path, rect, circle, polygon')]
    expect(shapes.length).toBeGreaterThan(0)
    for (const shape of shapes) {
      // Outlines and their own colours would break the one-weight, theme-following set.
      expect(shape.hasAttribute('stroke')).toBe(false)
      expect(shape.hasAttribute('fill')).toBe(false)
    }
    marks.add(svg.innerHTML)
  }
  expect(marks.size).toBe(KINDS.length)
})

it('sizes the mark and names its provider for styling', async () => {
  const container = await render('llamacpp', 24)
  const wrapper = container.firstElementChild!
  expect(wrapper.className).toBe('provider-icon provider-icon--llamacpp')
  expect(wrapper.getAttribute('aria-hidden')).toBe('true')
  expect(wrapper.querySelector('svg')!.getAttribute('height')).toBe('24')
})
