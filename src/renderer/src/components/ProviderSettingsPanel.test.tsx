// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ProviderSettingsPanel } from './ProviderSettingsPanel'

it('offers one simple connection test without capability diagnostics', async () => {
  const discoverModels = vi.fn(async () => ({ ok: true, models: [] }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { providers: { discoverModels } }
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  try {
    await act(async () =>
      root.render(
        <ProviderSettingsPanel
          instances={[
            {
              id: 'local',
              name: 'Local Server',
              type: 'openai-compatible',
              enabled: true,
              baseUrl: 'https://provider.test/v1',
              modelSource: 'discover',
              models: [{ id: 'local-model', enabled: true }]
            }
          ]}
          onChange={() => undefined}
        />
      )
    )

    expect(container.textContent).not.toContain('Test model capabilities')
    expect(container.textContent).not.toContain('synthetic requests')
    expect(container.textContent).not.toContain('Refresh models')
    const buttons = Array.from(container.querySelectorAll('button')).filter(
      (candidate) => candidate.textContent?.trim() === 'Test connection'
    )
    expect(buttons).toHaveLength(1)

    await act(async () => buttons[0].click())

    expect(discoverModels).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Connection successful')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
