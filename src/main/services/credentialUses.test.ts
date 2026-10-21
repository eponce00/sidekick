import { randomBytes } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import type { CredentialSummary, CredentialValues } from '../../shared/credentials'
import {
  CredentialUses,
  credentialApprovalFor,
  credentialRequestsFor,
  type CredentialStore,
  type CredentialUseRequest
} from './credentialUses'

const SECRET = randomBytes(16).toString('hex')

function credential(overrides: Partial<CredentialSummary> = {}): CredentialSummary {
  return {
    id: 'pc',
    alias: 'partner-center',
    kind: 'secret',
    description: 'Store submissions',
    usernameVisible: false,
    ask: 'once_per_chat',
    scope: {
      projects: 'all',
      background: false,
      web: {
        hosts: ['login.microsoftonline.com'],
        tokenHosts: ['api.partner.microsoft.com'],
        send: { as: 'form', name: 'client_secret' }
      }
    },
    createdAt: 1,
    updatedAt: 1,
    needsValue: false,
    ...overrides
  }
}

function setup(entries: CredentialSummary[] = [credential()]) {
  const record = vi.fn()
  const setTransientSecrets = vi.fn()
  const store: CredentialStore = {
    list: () => entries,
    resolve: (alias) => {
      const summary = entries.find((entry) => entry.alias === alias)
      return summary ? { summary, values: { secret: SECRET } as CredentialValues } : undefined
    },
    record,
    setTransientSecrets
  }
  let clock = 1_000
  const uses = new CredentialUses(
    store,
    () => ({ projectId: 'p1', background: false }),
    () => clock
  )
  const request = (overrides: Partial<CredentialUseRequest> = {}): CredentialUseRequest => ({
    alias: 'partner-center',
    tool: 'http_request',
    kind: 'web',
    target: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
    conversationId: 'chat-1',
    runId: 'run-1',
    ...overrides
  })
  return { uses, record, setTransientSecrets, request, advance: (ms: number) => (clock += ms) }
}

describe('CredentialUses', () => {
  it('describes an in-scope use for its approval card, never its value', () => {
    const { uses, request } = setup()
    const approval = uses.approval(request())!
    expect(approval).toMatchObject({
      alias: 'partner-center',
      ask: 'once_per_chat',
      keys: ['credential:pc:web:https://login.microsoftonline.com'],
      label: 'partner-center with login.microsoftonline.com'
    })
    expect(approval.preview.facts).toContainEqual({
      label: 'How',
      value: 'as the client_secret form field'
    })
    expect(JSON.stringify(approval)).not.toContain(SECRET)
  })

  it('never asks about a use outside scope, and refuses it when it runs', () => {
    const { uses, request, record } = setup()
    const elsewhere = request({ target: 'https://evil.example/collect' })
    expect(uses.approval(elsewhere)).toBeUndefined()
    const taken = uses.take(elsewhere)
    expect(taken).toEqual({
      ok: false,
      message: expect.stringContaining('login.microsoftonline.com')
    })
    expect(record).toHaveBeenCalledWith(
      'refused',
      expect.objectContaining({ alias: 'partner-center' }),
      expect.objectContaining({ target: 'https://evil.example/collect' })
    )
  })

  it.each([
    'http://login.microsoftonline.com/token',
    'https://login.microsoftonline.com:8443/token',
    'https://login.microsoftonline.com@evil.example/token',
    'not a url'
  ])('refuses %s', (target) => {
    const { uses, request } = setup()
    expect(uses.take(request({ target })).ok).toBe(false)
  })

  it('refuses an unknown alias, an entry without web use, and one outside its project', () => {
    const { uses, request } = setup([
      credential({ alias: 'no-web', scope: { projects: 'all', background: false } }),
      credential({
        id: 'p',
        alias: 'elsewhere',
        scope: { ...credential().scope, projects: ['p2'] }
      })
    ])
    expect(uses.take(request({ alias: 'missing' }))).toMatchObject({ ok: false })
    expect(uses.take(request({ alias: 'no-web' }))).toMatchObject({
      ok: false,
      message: expect.stringContaining('may not be sent in web requests')
    })
    expect(uses.take(request({ alias: 'elsewhere' }))).toMatchObject({
      ok: false,
      message: expect.stringContaining("this chat's project")
    })
  })

  it('records a use by where it went, without the query string', () => {
    const { uses, request, record } = setup()
    const taken = uses.take(request({ target: 'https://login.microsoftonline.com/t?secret=x' }))
    expect(taken).toMatchObject({ ok: true, values: { secret: SECRET } })
    expect(record).toHaveBeenCalledWith(
      'used',
      expect.anything(),
      expect.objectContaining({ target: 'https://login.microsoftonline.com/t' })
    )
  })

  it('lets a returned token go only to token hosts, in the same chat, until it expires', () => {
    const { uses, request, setTransientSecrets, advance } = setup()
    const token = randomBytes(24).toString('hex')
    const alias = uses.addDerived('partner-center', 'chat-1', token, 120)
    expect(alias).toBe('partner-center~1')
    expect(setTransientSecrets).toHaveBeenLastCalledWith([{ alias, value: token }])
    const api = request({ alias, target: 'https://api.partner.microsoft.com/v1/products' })
    expect(uses.take(api)).toMatchObject({
      ok: true,
      values: { secret: token },
      send: { as: 'header', name: 'Authorization', prefix: 'Bearer ' }
    })
    expect(uses.take({ ...api, target: 'https://login.microsoftonline.com/x' }).ok).toBe(false)
    expect(uses.take({ ...api, conversationId: 'chat-2' }).ok).toBe(false)
    advance(121_000)
    expect(uses.take(api)).toMatchObject({ ok: false, message: expect.stringContaining('expired') })
    expect(setTransientSecrets).toHaveBeenLastCalledWith([])
  })

  it('combines several uses into one approval, asking as the strictest entry does', () => {
    const { uses, request } = setup([
      credential(),
      credential({ id: 'b', alias: 'other', ask: 'every_use' })
    ])
    const approval = credentialApprovalFor(uses, [request(), request({ alias: 'other' })])!
    expect(approval.ask).toBe('every_use')
    expect(approval.keys).toHaveLength(2)
  })

  it('reads the credential from http_request arguments only', () => {
    expect(
      credentialRequestsFor(
        'http_request',
        { url: 'https://a.example', credential: ' partner-center ' },
        { conversationId: 'c', runId: 'r' }
      )
    ).toEqual([
      {
        alias: 'partner-center',
        tool: 'http_request',
        kind: 'web',
        target: 'https://a.example',
        conversationId: 'c',
        runId: 'r'
      }
    ])
    expect(credentialRequestsFor('web_fetch', { credential: 'partner-center' }, {})).toEqual([])
    expect(credentialRequestsFor('http_request', { url: 'https://a.example' }, {})).toEqual([])
  })

  it('records a denial', () => {
    const { uses, request, record } = setup()
    uses.denied(request())
    expect(record).toHaveBeenCalledWith('denied', expect.anything(), expect.anything())
  })
})
