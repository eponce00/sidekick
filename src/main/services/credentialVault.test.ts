import { randomBytes } from 'crypto'
import { describe, expect, it } from 'vitest'
import type { CredentialEvent, CredentialSaveInput } from '../../shared/credentials'
import { CredentialRedactor } from './credentialRedaction'
import {
  CredentialUnavailableError,
  CredentialVault,
  type CredentialCipher
} from './credentialVault'

function generated(): string {
  return randomBytes(18).toString('base64url')
}

/** A reversible stand-in for safeStorage whose output never contains the plaintext. */
function fakeCipher(): CredentialCipher & { available: boolean; broken: boolean } {
  const cipher = {
    available: true,
    broken: false,
    isAvailable: () => cipher.available,
    seal: (plaintext: string) =>
      Buffer.from(Buffer.from(plaintext, 'utf8').map((byte) => byte ^ 0x5a)).toString('base64'),
    open: (sealed: string) => {
      if (cipher.broken) throw new Error('Error while decrypting the ciphertext provided')
      return Buffer.from(Buffer.from(sealed, 'base64').map((byte) => byte ^ 0x5a)).toString('utf8')
    }
  }
  return cipher
}

function memory(): {
  persistence: ConstructorParameters<typeof CredentialVault>[1]
  raw: () => string
} {
  let file: unknown
  let events: CredentialEvent[] = []
  return {
    persistence: {
      read: () => (file === undefined ? undefined : JSON.parse(JSON.stringify(file))),
      write: (value) => {
        file = JSON.parse(JSON.stringify(value))
      },
      readEvents: () => JSON.parse(JSON.stringify(events)),
      writeEvents: (value) => {
        events = JSON.parse(JSON.stringify(value))
      }
    },
    raw: () => JSON.stringify({ file, events })
  }
}

function secretInput(overrides: Partial<CredentialSaveInput> = {}): CredentialSaveInput {
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

function setup(): {
  vault: CredentialVault
  cipher: ReturnType<typeof fakeCipher>
  store: ReturnType<typeof memory>
  redactor: CredentialRedactor
} {
  const cipher = fakeCipher()
  const store = memory()
  const redactor = new CredentialRedactor()
  let clock = 1_000
  let id = 0
  const vault = new CredentialVault(
    cipher,
    store.persistence,
    redactor,
    () => ++clock,
    () => `id-${++id}`
  )
  return { vault, cipher, store, redactor }
}

describe('CredentialVault', () => {
  it('stores values sealed and never returns them in summaries or events', () => {
    const { vault, store } = setup()
    const secret = generated()
    const username = generated()
    const password = generated()
    vault.save(secretInput({ values: { secret } }))
    vault.save(
      secretInput({
        alias: 'github-login',
        kind: 'sign_in',
        values: { username, password }
      })
    )
    const everything = JSON.stringify({ list: vault.list(), events: vault.events() })
    for (const value of [secret, username, password]) {
      expect(everything).not.toContain(value)
      expect(store.raw()).not.toContain(value)
    }
    expect(vault.list().map((entry) => entry.alias)).toEqual(['github-login', 'partner-center'])
  })

  it('shows a username only when the entry lets the agent read it', () => {
    const { vault } = setup()
    const username = generated()
    const saved = vault.save(
      secretInput({
        alias: 'site',
        kind: 'sign_in',
        usernameVisible: true,
        values: { username, password: generated() }
      })
    )
    expect(saved.username).toBe(username)
    const hidden = vault.save({
      ...secretInput({ kind: 'sign_in' }),
      id: saved.id,
      alias: 'site',
      usernameVisible: false,
      values: {}
    })
    expect(hidden.username).toBeUndefined()
  })

  it('keeps stored values when an edit brings no new ones', () => {
    const { vault } = setup()
    const secret = generated()
    const saved = vault.save(secretInput({ values: { secret } }))
    vault.save({ ...secretInput({ description: 'Renamed' }), id: saved.id, values: {} })
    expect(vault.resolve('partner-center')?.values.secret).toBe(secret)
    expect(vault.get(saved.id)?.description).toBe('Renamed')
  })

  it('refuses a second entry with the same alias', () => {
    const { vault } = setup()
    vault.save(secretInput())
    expect(() => vault.save(secretInput())).toThrow(/already called partner-center/)
  })

  it('refuses to save without protected storage', () => {
    const { vault, cipher } = setup()
    cipher.available = false
    expect(vault.status().available).toBe(false)
    expect(() => vault.save(secretInput())).toThrow(CredentialUnavailableError)
  })

  it('lists a record this computer cannot open as needing its values again', () => {
    const { vault, cipher, store, redactor } = setup()
    const saved = vault.save(secretInput())
    cipher.broken = true
    const reopened = new CredentialVault(cipher, store.persistence, redactor)
    reopened.load()
    expect(reopened.list()).toEqual([
      expect.objectContaining({
        id: saved.id,
        alias: 'partner-center',
        needsValue: true,
        scope: { projects: 'all', background: false }
      })
    ])
    expect(reopened.resolve('partner-center')).toBeUndefined()
    cipher.broken = false
    expect(() => reopened.save({ ...secretInput(), id: saved.id, values: {} })).toThrow(
      /Enter every value/
    )
  })

  it('ignores a sealed record that does not belong to its entry', () => {
    const { vault, cipher, store, redactor } = setup()
    const first = vault.save(secretInput())
    const second = vault.save(secretInput({ alias: 'other' }))
    const file = store.persistence.read() as {
      entries: Record<string, { sealed: string }>
    }
    // Swapping sealed records between entries must not hand one entry the other's value.
    file.entries[first.id].sealed = file.entries[second.id].sealed
    store.persistence.write(file as never)
    const reopened = new CredentialVault(cipher, store.persistence, redactor)
    reopened.load()
    expect(reopened.get(first.id)?.needsValue).toBe(true)
  })

  it('redacts every stored value, and replaced or deleted ones until restart', () => {
    const { vault, redactor } = setup()
    const first = generated()
    const second = generated()
    const saved = vault.save(secretInput({ values: { secret: first } }))
    expect(redactor.redact(first)).toBe('[secret: partner-center]')
    vault.save({ ...secretInput(), id: saved.id, values: { secret: second } })
    expect(redactor.redact(`${first} ${second}`)).toBe(
      '[secret: partner-center] [secret: partner-center]'
    )
    vault.delete(saved.id)
    expect(redactor.redact(second)).toBe('[secret: partner-center]')
  })

  it('records lifecycle events without values', () => {
    const { vault } = setup()
    const saved = vault.save(secretInput())
    vault.save({ ...secretInput(), id: saved.id, values: { secret: generated() } })
    vault.save({ ...secretInput({ ask: 'every_use' }), id: saved.id, values: {} })
    vault.delete(saved.id)
    expect(vault.events(saved.id).map((event) => event.kind)).toEqual([
      'deleted',
      'changed',
      'value_replaced',
      'created'
    ])
    expect(vault.events(saved.id)[1].detail).toBe('Changed when to ask.')
  })

  it('reports every way an edit widens an entry', () => {
    const { vault } = setup()
    const saved = vault.save(
      secretInput({
        kind: 'sign_in',
        ask: 'every_use',
        scope: { projects: ['a'], background: false },
        values: { username: generated(), password: generated() }
      })
    )
    expect(
      vault.widening({
        ...secretInput({ kind: 'sign_in' }),
        id: saved.id,
        ask: 'never',
        usernameVisible: true,
        scope: { projects: 'all', background: true }
      })
    ).toEqual([
      'Ask before use: Never, within its scope',
      'Usable in every project',
      'Usable by schedules and chats other chats start',
      'The agent can read the username'
    ])
    expect(
      vault.widening({
        ...secretInput({ kind: 'sign_in' }),
        id: saved.id,
        ask: 'every_use',
        scope: { projects: ['a'], background: false }
      })
    ).toEqual([])
  })

  it('keeps the newest thousand events', () => {
    const { vault } = setup()
    const saved = vault.save(secretInput())
    for (let index = 0; index < 1_005; index++) vault.record('used', { id: saved.id, alias: 'x' })
    expect(vault.events()).toHaveLength(1_000)
    expect(vault.get(saved.id)?.lastUsedAt).toBeGreaterThan(0)
  })
})
