import { randomBytes } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CredentialEvent, CredentialSaveInput } from '../../shared/credentials'
import { CredentialRedactor } from '../services/credentialRedaction'
import { CredentialVault } from '../services/credentialVault'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  dialog: vi.fn(async () => ({ response: 1 })),
  vault: null as unknown as CredentialVault
}))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  ipcMain: {
    handle: (name: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler)
  }
}))
vi.mock('./state', () => ({ appState: { mainWindowRef: null } }))
vi.mock('../bootstrap/windowActivation', () => ({ revealWindow: () => undefined }))
vi.mock('../services/trustedDialog', () => ({ showTrustedDialog: mocks.dialog }))
vi.mock('../services/credentialVaultInstance', () => ({ getCredentialVault: () => mocks.vault }))
import { registerCredentialHandlers } from './credentials'

function generated(): string {
  return randomBytes(18).toString('base64url')
}

function newVault(): CredentialVault {
  let file: unknown
  let events: CredentialEvent[] = []
  let id = 0
  return new CredentialVault(
    {
      isAvailable: () => true,
      seal: (plaintext) =>
        Buffer.from(Buffer.from(plaintext).map((byte) => byte ^ 0x5a)).toString('base64'),
      open: (sealed) =>
        Buffer.from(Buffer.from(sealed, 'base64').map((byte) => byte ^ 0x5a)).toString()
    },
    {
      read: () => file,
      write: (value) => {
        file = JSON.parse(JSON.stringify(value))
      },
      readEvents: () => events,
      writeEvents: (value) => {
        events = value
      }
    },
    new CredentialRedactor(),
    Date.now,
    () => `id-${++id}`
  )
}

const event = { sender: {} }
const call = (name: string, ...args: unknown[]) => mocks.handlers.get(name)!(event, ...args)

function input(overrides: Partial<CredentialSaveInput> = {}): CredentialSaveInput {
  return {
    alias: 'partner-center',
    kind: 'secret',
    description: 'Store submissions',
    usernameVisible: false,
    ask: 'once_per_chat',
    scope: { projects: 'all', background: false },
    values: { secret: generated() },
    ...overrides
  }
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.dialog.mockReset()
  mocks.dialog.mockResolvedValue({ response: 1 })
  mocks.vault = newVault()
  registerCredentialHandlers()
})

describe('credentials IPC', () => {
  it('never returns a stored value, its length or any part of it, from any call', async () => {
    const secret = generated()
    const username = generated()
    const password = generated()
    const responses: unknown[] = []
    const saved = (await call('credentials:save', input({ values: { secret } }))) as {
      credential: { id: string }
    }
    responses.push(saved)
    responses.push(
      await call(
        'credentials:save',
        input({ alias: 'site', kind: 'sign_in', values: { username, password } })
      )
    )
    responses.push(await call('credentials:status'))
    responses.push(await call('credentials:list'))
    responses.push(await call('credentials:events'))
    responses.push(await call('credentials:events', saved.credential.id))
    responses.push(await call('credentials:delete', saved.credential.id))
    const everything = JSON.stringify(responses)
    for (const value of [secret, username, password]) {
      expect(everything).not.toContain(value)
      expect(everything).not.toContain(value.slice(0, 8))
      expect(everything).not.toContain(value.slice(-8))
    }
  })

  it('confirms a widening edit in a trusted dialog, and Cancel saves nothing', async () => {
    const saved = (await call('credentials:save', input())) as { credential: { id: string } }
    expect(mocks.dialog).not.toHaveBeenCalled()
    mocks.dialog.mockResolvedValue({ response: 0 })
    const widened = input({ id: saved.credential.id, ask: 'never', values: {} } as never)
    expect(await call('credentials:save', widened)).toMatchObject({ ok: false, cancelled: true })
    expect(mocks.dialog).toHaveBeenCalledOnce()
    expect(mocks.vault.get(saved.credential.id)?.ask).toBe('once_per_chat')
    mocks.dialog.mockResolvedValue({ response: 1 })
    expect(await call('credentials:save', widened)).toMatchObject({ ok: true })
    expect(mocks.vault.get(saved.credential.id)?.ask).toBe('never')
  })

  it('deletes only after the user confirms in a trusted dialog', async () => {
    const saved = (await call('credentials:save', input())) as { credential: { id: string } }
    mocks.dialog.mockResolvedValue({ response: 0 })
    expect(await call('credentials:delete', saved.credential.id)).toMatchObject({ deleted: false })
    expect(mocks.vault.get(saved.credential.id)).toBeDefined()
    mocks.dialog.mockResolvedValue({ response: 1 })
    expect(await call('credentials:delete', saved.credential.id)).toMatchObject({ deleted: true })
    expect(mocks.vault.get(saved.credential.id)).toBeUndefined()
    expect(mocks.dialog).toHaveBeenCalledTimes(2)
  })

  it('stores a pasted key with one kind of line ending and a copied token without spaces', async () => {
    const lines = [generated(), generated(), generated()]
    await call('credentials:save', input({ values: { secret: `${lines.join('\r\n')}\r\n` } }))
    expect(mocks.vault.resolve('partner-center')?.values.secret).toBe(lines.join('\n'))
    const token = generated()
    await call('credentials:save', input({ alias: 'token', values: { secret: `  ${token}\n` } }))
    expect(mocks.vault.resolve('token')?.values.secret).toBe(token)
    const password = ` ${generated()} `
    await call(
      'credentials:save',
      input({ alias: 'site', kind: 'sign_in', values: { username: ' me ', password } })
    )
    expect(mocks.vault.resolve('site')?.values).toEqual({ username: 'me', password })
  })

  it('refuses a secret or password too short to keep out of output', async () => {
    expect(await call('credentials:save', input({ values: { secret: 'abc' } }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('at least 4 characters')
    })
    expect(await call('credentials:save', input({ values: { secret: '   ' } }))).toMatchObject({
      ok: false
    })
    expect(mocks.vault.list()).toEqual([])
  })
})
