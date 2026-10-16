import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlError } from '../../shared/controlProtocol'
import {
  createProviderControlHandlers,
  type ProviderControlDependencies
} from './controlProviderMethods'

const BLOB = Buffer.from('enc:sk-real').toString('base64')

let stored: Record<string, unknown>
let deps: ProviderControlDependencies & {
  confirmProviderEndpoint: ReturnType<typeof vi.fn>
  settingsChanged: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  stored = {
    providerInstances: [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        type: 'openrouter',
        enabled: true,
        baseUrl: 'https://openrouter.ai/api/v1',
        modelSource: 'discover',
        models: [{ id: 'model-a', enabled: true }]
      }
    ],
    __encryptedProviderSecrets: { openrouter: BLOB }
  }
  deps = {
    store: {
      get: vi.fn((key: string, fallback?: unknown) => (key === 'settings' ? stored : fallback)),
      set: vi.fn((_key: string, value: unknown) => {
        stored = value as Record<string, unknown>
      })
    },
    settingsChanged: vi.fn(),
    confirmProviderEndpoint: vi.fn(async () => true)
  } as unknown as typeof deps
})

const handlers = (): ReturnType<typeof createProviderControlHandlers> =>
  createProviderControlHandlers(deps)

async function rejection(promise: Promise<unknown>): Promise<ControlError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(ControlError)
  return error as ControlError
}

describe('provider.set', () => {
  it('asks before moving a provider with a stored key to a new address', async () => {
    await handlers()['provider.set']({ id: 'openrouter', baseUrl: 'https://proxy.example.com/v1' })
    expect(deps.confirmProviderEndpoint).toHaveBeenCalledWith({
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      previousUrl: 'https://openrouter.ai/api/v1',
      nextUrl: 'https://proxy.example.com/v1',
      keyStored: true
    })
    expect(stored.providerInstances).toEqual([
      expect.objectContaining({ baseUrl: 'https://proxy.example.com/v1' })
    ])
  })

  it('leaves the address alone when the user declines', async () => {
    deps.confirmProviderEndpoint.mockResolvedValue(false)
    const error = await rejection(
      handlers()['provider.set']({ id: 'openrouter', baseUrl: 'https://evil.example.com/v1' })
    )
    expect(error.code).toBe('denied')
    expect(deps.store.set).not.toHaveBeenCalled()
  })

  it('renames and toggles without asking', async () => {
    const result = await handlers()['provider.set']({
      id: 'openrouter',
      name: 'Router',
      enabled: false
    })
    expect(deps.confirmProviderEndpoint).not.toHaveBeenCalled()
    expect(result.changed).toEqual(['name', 'enabled'])
    expect(stored.__encryptedProviderSecrets).toEqual({ openrouter: BLOB })
  })

  it.each([
    'https://user:pass@example.com/v1',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url'
  ])('refuses base URL %j', async (baseUrl) => {
    const error = await rejection(handlers()['provider.set']({ id: 'openrouter', baseUrl }))
    expect(error.code).toBe('invalid-value')
    expect(deps.confirmProviderEndpoint).not.toHaveBeenCalled()
  })
})

describe('provider.add', () => {
  it('adds an instance at the default address without asking', async () => {
    const result = await handlers()['provider.add']({ id: 'local', kind: 'ollama' })
    expect(deps.confirmProviderEndpoint).not.toHaveBeenCalled()
    expect(result.provider).toMatchObject({
      id: 'local',
      kind: 'ollama',
      baseUrl: 'http://localhost:11434',
      apiKeyConfigured: false
    })
  })

  it('asks before using a non-default address', async () => {
    deps.confirmProviderEndpoint.mockResolvedValue(false)
    const error = await rejection(
      handlers()['provider.add']({ id: 'lan', kind: 'ollama', baseUrl: 'http://192.168.1.5:11434' })
    )
    expect(error.code).toBe('denied')
    expect(deps.confirmProviderEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ previousUrl: null, nextUrl: 'http://192.168.1.5:11434' })
    )
  })

  it('refuses unknown kinds and existing ids', async () => {
    expect((await rejection(handlers()['provider.add']({ id: 'x', kind: 'nope' }))).code).toBe(
      'invalid-value'
    )
    expect(
      (await rejection(handlers()['provider.add']({ id: 'openrouter', kind: 'openrouter' }))).code
    ).toBe('invalid-value')
  })
})

describe('provider.list and provider.remove', () => {
  it('lists keys as booleans only', async () => {
    const result = await handlers()['provider.list']({})
    expect(result.providers).toEqual([
      {
        id: 'openrouter',
        name: 'OpenRouter',
        kind: 'openrouter',
        enabled: true,
        baseUrl: 'https://openrouter.ai/api/v1',
        modelSource: 'discover',
        enabledModels: ['model-a'],
        apiKeyConfigured: true
      }
    ])
    expect(JSON.stringify(result)).not.toContain(BLOB)
  })

  it('removes the instance and its encrypted key', async () => {
    await handlers()['provider.remove']({ id: 'openrouter' })
    expect(stored.providerInstances).toEqual([])
    expect(stored.__encryptedProviderSecrets).toEqual({})
  })
})
