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

describe('chat models', () => {
  const QWEN = 'ollama:ollama-local/qwen3:8b'
  const SONNET = 'openrouter:openrouter/anthropic/claude-sonnet-4'
  let setModel: ReturnType<typeof vi.fn>
  let saveSettings: ReturnType<typeof vi.fn>
  let startConversation: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = (): void => undefined
        unobserve = (): void => undefined
        disconnect = (): void => undefined
      }
    )
    if (!globalThis.CSS?.escape) {
      vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/["\\]/g, '\\$&') })
    }
    // Recorded rather than kept, so each test starts from the preview chats as they are.
    setModel = vi.fn(async () => ({ success: true }))
    saveSettings = vi.fn(async () => ({ success: true }))
    const startPreviewRun = window.api.agentRuns.startConversation
    startConversation = vi.fn(startPreviewRun)
    Object.assign(window.api.conversations, { setModel })
    Object.assign(window.api.settings, { save: saveSettings })
    Object.assign(window.api.agentRuns, { startConversation })
  })

  afterEach(() => vi.unstubAllGlobals())

  const settle = (): Promise<void> => act(async () => new Promise((done) => setTimeout(done, 0)))
  const visiblePanel = (): HTMLElement =>
    container.querySelector<HTMLElement>('.conversation-panel-slot:not([hidden])')!
  const pickerLabel = (): string =>
    visiblePanel().querySelector('.model-selector-inline-label')?.textContent ?? ''

  async function click(element: Element | null | undefined): Promise<void> {
    expect(element).toBeTruthy()
    await act(async () => (element as HTMLElement).click())
    await settle()
  }

  async function openChat(title: string): Promise<void> {
    await click(container.querySelector(`button.conversation-select-button[title^="${title}"]`))
  }

  async function chooseModel(name: string): Promise<void> {
    await click(visiblePanel().querySelector('.model-selector-inline'))
    // A model with reasoning opens on its effort; the list is behind its name.
    const toList = visiblePanel().querySelector('.effort-card-model')
    if (toList) await click(toList)
    await click(
      [...visiblePanel().querySelectorAll('.model-menu-option')].find((option) =>
        option.textContent?.includes(name)
      )
    )
  }

  async function send(text: string): Promise<void> {
    const input = visiblePanel().querySelector('textarea')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(visiblePanel().querySelector('.send-button'))
  }

  it('keeps each chat on its own model and starts a new chat on the last one chosen', async () => {
    await act(async () => root.render(<App />))
    await settle()

    await openChat('Research local model options')
    expect(pickerLabel()).toContain('Qwen')
    await chooseModel('Sonnet')
    expect(setModel).toHaveBeenLastCalledWith('preview-2', SONNET)
    expect(saveSettings).toHaveBeenLastCalledWith({ selectedModel: SONNET })

    await openChat('Refine the desktop experience')
    expect(pickerLabel()).toContain('Sonnet')
    await chooseModel('Qwen')
    expect(setModel).toHaveBeenLastCalledWith('preview-1', QWEN)
    expect(saveSettings).toHaveBeenLastCalledWith({ selectedModel: QWEN })

    // Choosing Qwen in the other chat left this one on the model chosen in it.
    await openChat('Research local model options')
    expect(pickerLabel()).toContain('Sonnet')

    const create = vi.spyOn(window.api.conversations, 'create')
    await click(container.querySelector('button[aria-label="New standalone chat"]'))
    expect(create).toHaveBeenCalledWith('New Conversation', null, 'placeholder', QWEN)
    expect(pickerLabel()).toContain('Qwen')
  })

  it('runs a chat on its own model, not the new-chat default', async () => {
    await act(async () => root.render(<App />))
    await settle()

    await openChat('Research local model options')
    await chooseModel('Sonnet')
    await openChat('Refine the desktop experience')
    await chooseModel('Qwen')
    await openChat('Research local model options')
    await send('Which local model should I try first?')

    expect(startConversation).toHaveBeenCalledTimes(1)
    expect(startConversation.mock.calls[0][0]).toMatchObject({
      conversationId: 'preview-2',
      model: { id: SONNET }
    })
  })

  it('asks for another model when the chat’s own is no longer set up', async () => {
    await act(async () => root.render(<App />))
    await settle()

    await openChat('Build release checklist')
    expect(pickerLabel()).toBe('Unavailable: qwen2.5-coder-14b')
    expect(visiblePanel().querySelector('.composer-model-missing-bar')?.textContent).toContain(
      'qwen2.5-coder-14b is no longer available'
    )

    await send('Draft the release checklist')
    expect(startConversation).not.toHaveBeenCalled()
    expect(visiblePanel().querySelector('.model-menu')).toBeTruthy()

    await click(
      [...visiblePanel().querySelectorAll('.model-menu-option')].find((option) =>
        option.textContent?.includes('Qwen')
      )
    )
    expect(setModel).toHaveBeenLastCalledWith('preview-3', QWEN)
    expect(visiblePanel().querySelector('.composer-model-missing-bar')).toBeNull()
  })
})
