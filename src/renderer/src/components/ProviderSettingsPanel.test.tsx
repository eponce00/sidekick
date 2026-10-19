// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderSettingsPanel } from './ProviderSettingsPanel'
import type { ProviderDiscoveryResult } from '../../../shared/providerRuntime'
import type { ProviderInstance, ProviderInstanceModel } from '../../../shared/settings'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const provider = (updates: Partial<ProviderInstance>): ProviderInstance => ({
  id: 'local',
  name: 'Local Server',
  type: 'openai-compatible',
  enabled: true,
  baseUrl: 'https://provider.test/v1',
  modelSource: 'discover',
  models: [],
  ...updates
})

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

/** Renders the panel the way Settings does: every change comes back as the new instances. */
async function mount(
  initial: ProviderInstance[],
  discover: (draft: ProviderInstance) => ProviderDiscoveryResult = () => ({ ok: true, models: [] })
) {
  const discoverModels = vi.fn(async ({ draft }: { draft: ProviderInstance }) => discover(draft))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { providers: { discoverModels } }
  })
  container = document.createElement('div')
  document.body.append(container)
  const mounted = createRoot(container)
  root = mounted
  let instances = initial
  // Changes arrive inside the act() of whatever caused them, so they render directly.
  const draw = (): void =>
    mounted.render(
      <ProviderSettingsPanel
        instances={instances}
        onChange={(next) => {
          instances = next
          draw()
        }}
      />
    )
  await act(async () => draw())
  // Lets a load the panel starts by itself finish.
  await act(async () => undefined)
  return { discoverModels, instances: () => instances, element: container }
}

const button = (label: string): HTMLButtonElement | undefined =>
  Array.from(container!.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )

const rowNames = (): string[] =>
  Array.from(container!.querySelectorAll('.provider-model-row strong')).map(
    (node) => node.textContent ?? ''
  )

const model = (
  id: string,
  details: Partial<ProviderInstanceModel> = {}
): ProviderInstanceModel => ({
  id,
  name: id,
  enabled: false,
  ...details
})

describe('ProviderSettingsPanel models', () => {
  it('loads what the provider offers beside the models already shown in chat', async () => {
    const view = await mount(
      [provider({ models: [model('local-model', { enabled: true })] })],
      () => ({
        ok: true,
        models: [
          model('local-model', { enabled: true }),
          model('big-model', {
            contextLength: 131_072,
            maxOutputTokens: 16_384,
            supportsTools: true
          })
        ]
      })
    )
    expect(view.discoverModels).not.toHaveBeenCalled()
    expect(view.element.textContent).not.toContain('Test model capabilities')

    await act(async () => button('Refresh models')!.click())

    expect(view.discoverModels).toHaveBeenCalledTimes(1)
    expect(view.instances()[0].models).toEqual([
      expect.objectContaining({ id: 'big-model', enabled: false, contextLength: 131_072 }),
      expect.objectContaining({ id: 'local-model', enabled: true })
    ])
    expect(view.instances()[0].health).toMatchObject({ status: 'online', discoveredModelCount: 2 })
    expect(view.element.textContent).toContain('Connected · 2 models available')
    expect(view.element.textContent).toContain('128K context · 16K output')
    expect(view.element.querySelector('[aria-label="Tools"]')).not.toBeNull()
  })

  it('loads the list by itself when a provider without models opens, once', async () => {
    const view = await mount(
      [provider({ type: 'ollama', baseUrl: 'http://localhost:11434' })],
      () => ({
        ok: true,
        models: [model('qwen3:8b')]
      })
    )
    expect(view.discoverModels).toHaveBeenCalledTimes(1)
    expect(rowNames()).toEqual(['qwen3:8b'])
    expect(button('Refresh models')).toBeDefined()

    await act(async () => button('Hide all')!.click())
    expect(view.discoverModels).toHaveBeenCalledTimes(1)
  })

  it('waits for a key, then loads when one is entered', async () => {
    const view = await mount(
      [
        provider({
          id: 'openrouter',
          name: 'OpenRouter',
          type: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1'
        })
      ],
      (draft) =>
        draft.apiKey === 'sk-test'
          ? { ok: true, models: [model('openai/gpt-5-mini')] }
          : { ok: false, error: 'OpenRouter requires an API key' }
    )
    expect(view.discoverModels).not.toHaveBeenCalled()
    expect(view.element.textContent).toContain('Enter the API key')

    const key = view.element.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        key,
        'sk-test'
      )
      key.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      key.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })

    expect(view.discoverModels).toHaveBeenCalledTimes(1)
    expect(rowNames()).toEqual(['gpt-5-mini'])
  })

  it('lists models in chat first and filters by what a model can do', async () => {
    await mount([
      provider({
        models: [
          model('alpha', { supportsVision: true }),
          model('beta', { enabled: true, supportsTools: true }),
          model('gamma', { supportsVision: false })
        ]
      })
    ])
    const groups = Array.from(container!.querySelectorAll('.provider-model-list > [role="group"]'))
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'In chat',
      'Available'
    ])
    expect(rowNames()).toEqual(['beta', 'alpha', 'gamma'])

    await act(async () => button('Vision')!.click())
    expect(rowNames()).toEqual(['alpha'])
    expect(button('Vision')!.getAttribute('aria-pressed')).toBe('true')
    expect(container!.textContent).toContain('1 of 3 models · 1 in chat')

    await act(async () => button('Tools')!.click())
    expect(container!.textContent).toContain('No models match these filters')
    await act(async () => button('Clear filters')!.click())
    expect(rowNames()).toHaveLength(3)
  })

  it('keeps a chosen model the provider stops listing, and says which models are new', async () => {
    let listed = [model('kept'), model('dropped')]
    const view = await mount(
      [
        provider({
          models: [model('kept', { enabled: true }), model('dropped', { enabled: true })],
          health: { status: 'online', checkedAt: 1, discoveredModelCount: 2 }
        })
      ],
      () => ({ ok: true, models: listed })
    )
    listed = [model('kept'), model('fresh')]

    await act(async () => button('Refresh models')!.click())

    expect(view.instances()[0].models.map(({ id, enabled }) => [id, enabled])).toEqual([
      ['dropped', true],
      ['fresh', false],
      ['kept', true]
    ])
    const tags = Array.from(container!.querySelectorAll('.provider-model-row')).map((row) => [
      row.querySelector('strong')?.textContent,
      row.querySelector('.provider-model-tag')?.textContent ?? null
    ])
    expect(tags).toEqual([
      ['dropped', 'Not listed'],
      ['kept', null],
      ['fresh', 'New']
    ])
  })

  it('says why loading failed and keeps the models it had', async () => {
    const view = await mount(
      [provider({ models: [model('local-model', { enabled: true })] })],
      () => ({
        ok: false,
        error: 'HTTP 401: invalid key'
      })
    )
    await act(async () => button('Refresh models')!.click())
    expect(view.element.querySelector('[role="status"]')?.textContent).toContain('401')
    expect(view.instances()[0].health?.status).toBe('offline')
    expect(view.instances()[0].models).toHaveLength(1)
  })

  it('only tests the connection of a server whose models are named by hand', async () => {
    const view = await mount(
      [
        provider({
          type: 'llamacpp',
          baseUrl: 'http://localhost:8080/v1',
          modelSource: 'manual',
          models: [model('local-model', { enabled: true })]
        })
      ],
      (draft) => ({ ok: true, models: draft.models })
    )
    expect(view.discoverModels).not.toHaveBeenCalled()
    expect(button('Vision')).toBeUndefined()

    await act(async () => button('Test connection')!.click())
    expect(view.element.textContent).toContain('Connection successful')
    expect(view.instances()[0].models).toEqual([model('local-model', { enabled: true })])
  })

  it('keeps adding models by id after the first one, whatever the provider', async () => {
    const view = await mount([provider({})])
    const add = async (id: string): Promise<void> => {
      const input = container!.querySelector<HTMLInputElement>('.manual-model-row input')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, id)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => button('Add model')!.click())
    }

    await add('first-model')
    await add('second-model')
    expect(view.instances()[0].models.map((item) => item.id)).toEqual([
      'first-model',
      'second-model'
    ])

    const remove = container!.querySelector<HTMLButtonElement>('[aria-label^="Remove"]')
    await act(async () => remove!.click())
    expect(view.instances()[0].models).toHaveLength(1)
  })
})
