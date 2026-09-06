// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ProviderCapabilityPanel } from './ProviderCapabilityPanel'

it('requires explicit selection, runs the probe, and copies only anonymous metrics', async () => {
  const probe = vi.fn(async () => ({
    model: 'private-alias',
    reportedModels: ['private-model'],
    checks: [{ capability: 'tools', status: 'observed', durationMs: 12 }]
  }))
  const writeText = vi.fn(async (_text: string) => ({ success: true }))
  const cancelProbe = vi.fn(async () => undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { providers: { probe, cancelProbe }, clipboard: { writeText } }
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <ProviderCapabilityPanel
          instance={{
            id: 'saved',
            name: 'Local',
            type: 'litellm',
            enabled: true,
            baseUrl: 'https://private.test',
            modelSource: 'manual',
            models: [{ id: 'private-alias', enabled: true }]
          }}
        />
      )
    )
    expect(container.querySelector('button')?.disabled).toBe(true)
    await act(async () => {
      const select = container.querySelector('select')!
      select.value = 'private-alias'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => container.querySelector('button')!.click())
    expect(probe).toHaveBeenCalledWith(
      { providerInstanceId: 'saved', providerKind: 'litellm', model: 'private-alias' },
      false
    )
    expect(container.textContent).toContain('tools: observed')
    expect(container.textContent).toContain('not reported')
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Copy anonymous'))!
        .click()
    )
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).not.toContain('private')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
  expect(cancelProbe).toHaveBeenCalled()
})
