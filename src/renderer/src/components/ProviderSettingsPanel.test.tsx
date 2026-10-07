// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ProviderSettingsPanel } from './ProviderSettingsPanel'
import type { ProviderInstance } from '../../../shared/settings'

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

it('keeps adding models after the first one, whatever the provider', async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { providers: { discoverModels: vi.fn() } }
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let instances: ProviderInstance[] = [
    {
      id: 'local',
      name: 'Local Server',
      type: 'openai-compatible',
      enabled: true,
      baseUrl: 'https://provider.test/v1',
      modelSource: 'discover',
      models: []
    }
  ]
  const render = async (): Promise<void> =>
    act(async () =>
      root.render(
        <ProviderSettingsPanel
          instances={instances}
          onChange={(next) => {
            instances = next
            void render()
          }}
        />
      )
    )
  const add = async (id: string): Promise<void> => {
    const input = container.querySelector<HTMLInputElement>('.manual-model-row input')
    expect(input).not.toBeNull()
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(input, id)
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Add model'
    )
    await act(async () => button!.click())
  }

  try {
    await render()
    await add('first-model')
    await add('second-model')

    expect(instances[0].models.map((model) => model.id)).toEqual(['first-model', 'second-model'])

    const remove = container.querySelector<HTMLButtonElement>('[aria-label^="Remove"]')
    await act(async () => remove!.click())
    expect(instances[0].models).toHaveLength(1)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
