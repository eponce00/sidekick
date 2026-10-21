// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CredentialSaveInput, CredentialSummary } from '../../../shared/credentials'
import { CredentialSettings } from './CredentialSettings'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const STORED: CredentialSummary = {
  id: 'one',
  alias: 'partner-center',
  kind: 'secret',
  description: 'Store submissions',
  usernameVisible: false,
  ask: 'once_per_chat',
  scope: { projects: 'all', background: false },
  createdAt: 1,
  updatedAt: 1,
  needsValue: false
}

let container: HTMLDivElement
let root: Root
let save: ReturnType<typeof vi.fn>

beforeEach(() => {
  save = vi.fn(async (input: CredentialSaveInput) => ({
    ok: true,
    credential: { ...STORED, ...input, id: input.id ?? 'two' },
    credentials: [STORED]
  }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      credentials: {
        status: async () => ({ available: true }),
        list: async () => [STORED],
        save,
        delete: vi.fn(async () => ({ deleted: true, credentials: [] })),
        events: async () => [],
        onChanged: () => () => undefined
      },
      projects: { list: async () => [] }
    }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function button(name: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name
  )
  expect(match, name).toBeDefined()
  return match!
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

it('lists credentials by alias with what the agent may do', async () => {
  await act(async () => root.render(<CredentialSettings />))
  expect(container.textContent).toContain('partner-center')
  expect(container.textContent).toContain('Store submissions')
  expect(container.textContent).toContain('first use in each chat')
})

it('never fills a stored value into the editor and keeps it unless a new one is typed', async () => {
  await act(async () => root.render(<CredentialSettings />))
  await act(async () => button('Edit partner-center').click())
  const secret = container.querySelector<HTMLInputElement>('input[type="password"]')!
  expect(secret.value).toBe('')
  expect(secret.placeholder).toBe('Stored. Type a new value to replace it.')
  await act(async () => button('Save credential').click())
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'one', values: {} }))
})

it('sends a new value only once, straight to the main process', async () => {
  await act(async () => root.render(<CredentialSettings />))
  await act(async () => button('Add credential').click())
  const alias = container.querySelector<HTMLInputElement>('.credential-alias-input')!
  const secret = container.querySelector<HTMLInputElement>('input[type="password"]')!
  await act(async () => {
    type(alias, 'github-token')
    type(secret, 'short')
  })
  expect(container.textContent).toContain('cannot be reliably kept out of output')
  await act(async () => button('Save credential').click())
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ alias: 'github-token', kind: 'secret', values: { secret: 'short' } })
  )
})

it('opens the editor the agent asked for, prefilled but without a value', async () => {
  await act(async () =>
    root.render(
      <CredentialSettings
        request={{ value: { alias: 'new-key', description: 'For the API' }, at: 1 }}
      />
    )
  )
  expect(container.textContent).toContain('New credential')
  expect(container.querySelector<HTMLInputElement>('.credential-alias-input')!.value).toBe(
    'new-key'
  )
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('For the API')
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('')
})

it('explains when the computer has no protected storage', async () => {
  ;(window.api.credentials as { status: () => Promise<unknown> }).status = async () => ({
    available: false,
    reason: 'No keychain.'
  })
  await act(async () => root.render(<CredentialSettings />))
  expect(container.textContent).toContain('Credentials are unavailable')
  expect(container.textContent).toContain('No keychain.')
})
