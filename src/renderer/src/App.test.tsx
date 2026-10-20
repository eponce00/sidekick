// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowserApiMock } from './dev/browserApiMock'
import App from './App'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

beforeEach(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  })) as typeof window.matchMedia
  installBrowserApiMock()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'api')
})

describe('settings at startup', () => {
  it('keeps a provider saved while the window was still loading its settings', async () => {
    // What the main process stores; a save replaces only the settings it names.
    let stored: Record<string, unknown> = {}
    const pinnedModels = deferred<[]>()
    const save = vi.fn(async (changes: Record<string, unknown>) => {
      stored = { ...stored, ...changes }
      return { success: true }
    })
    Object.assign(window.api.settings, {
      load: async () => structuredClone(stored),
      save
    })
    Object.assign(window.api.pinnedModels, { load: () => pinnedModels.promise })

    await act(async () => root.render(<App />))
    // The window has read its settings and waits for its pinned models. Another writer, here the
    // behavior test's own save, adds a provider in between.
    const provider = {
      id: 'family-provider',
      name: 'Scripted loopback model',
      type: 'openai-compatible',
      enabled: true,
      baseUrl: 'http://127.0.0.1:40000/v1',
      modelSource: 'manual',
      models: [{ id: 'family-fixture', enabled: true }]
    }
    await window.api.settings.save({ providerInstances: [provider] } as never)
    await act(async () => pinnedModels.resolve([]))
    await act(async () => new Promise((done) => setTimeout(done, 0)))

    expect(stored.providerInstances).toEqual([provider])
    expect(save).toHaveBeenCalledTimes(1)
  })
})
