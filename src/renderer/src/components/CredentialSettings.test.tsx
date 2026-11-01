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
      }
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

it('never fills a stored value into the editor and keeps it unless a new one is typed', async () => {
  await act(async () => root.render(<CredentialSettings />))
  await act(async () => button('Edit partner-center').click())
  const secret = container.querySelector<HTMLTextAreaElement>('.credential-value-input textarea')!
  expect(secret.value).toBe('')
  await act(async () => button('Save credential').click())
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'one', values: {} }))
})

it('sends a new value only once, straight to the main process', async () => {
  await act(async () => root.render(<CredentialSettings />))
  await act(async () => button('Add credential').click())
  const alias = container.querySelector<HTMLInputElement>('.credential-alias-input')!
  const secret = container.querySelector<HTMLTextAreaElement>('.credential-value-input textarea')!
  await act(async () => {
    type(alias, 'github-token')
    type(secret, 'short')
  })
  await act(async () => button('Save credential').click())
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ alias: 'github-token', kind: 'secret', values: { secret: 'short' } })
  )
})

it('opens the editor the agent asked for, prefilled but without a value', async () => {
  await act(async () =>
    root.render(
      <CredentialSettings
        request={{
          value: { alias: 'new-key', description: 'For the API', site: 'api.example.com' },
          at: 1
        }}
      />
    )
  )
  expect(container.querySelector<HTMLInputElement>('input[id$="-sites"]')!.value).toBe(
    'api.example.com'
  )
  expect(container.querySelector<HTMLInputElement>('.credential-alias-input')!.value).toBe(
    'new-key'
  )
  const description = container.querySelector<HTMLTextAreaElement>('textarea[id$="-description"]')!
  expect(description.value).toBe('For the API')
  expect(
    container.querySelector<HTMLTextAreaElement>('.credential-value-input textarea')!.value
  ).toBe('')
})

it('takes a multi-line key, masked, and sends it with its line breaks', async () => {
  await act(async () => root.render(<CredentialSettings />))
  await act(async () => button('Add credential').click())
  const secret = container.querySelector<HTMLTextAreaElement>('.credential-value-input textarea')!
  expect(secret.classList.contains('is-masked')).toBe(true)
  const key = [
    '-----BEGIN PRIVATE KEY-----',
    'MIIEvQ' + 'a'.repeat(40),
    '-----END PRIVATE KEY-----'
  ]
  await act(async () => {
    type(container.querySelector<HTMLInputElement>('.credential-alias-input')!, 'deploy-key')
    type(secret, `${key.join('\n')}\n`)
  })
  await act(async () => button('Show what you typed').click())
  expect(secret.classList.contains('is-masked')).toBe(false)
  await act(async () => button('Save credential').click())
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ alias: 'deploy-key', values: { secret: `${key.join('\n')}\n` } })
  )
})

it('makes an entry with a username a sign-in, and keeps the stored username on edit', async () => {
  const site: CredentialSummary = {
    ...STORED,
    id: 'site',
    alias: 'github',
    kind: 'sign_in',
    username: 'octo-user'
  }
  ;(window.api.credentials as { list: () => Promise<unknown> }).list = async () => [site]
  await act(async () => root.render(<CredentialSettings />))
  await act(async () => button('Edit github').click())
  const username = container.querySelector<HTMLInputElement>('input[id$="-username"]')!
  expect(username.value).toBe('octo-user')
  await act(async () => button('Save credential').click())
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: 'site', kind: 'sign_in', values: {} })
  )

  await act(async () => button('Add credential').click())
  await act(async () => {
    type(container.querySelector<HTMLInputElement>('.credential-alias-input')!, 'Build Server')
    type(container.querySelector<HTMLInputElement>('input[id$="-username"]')!, 'deploy')
    type(
      container.querySelector<HTMLTextAreaElement>('.credential-value-input textarea')!,
      'generated-password-value'
    )
  })
  await act(async () => button('Save credential').click())
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({
      alias: 'build-server',
      kind: 'sign_in',
      values: { username: 'deploy', password: 'generated-password-value' }
    })
  )
})
