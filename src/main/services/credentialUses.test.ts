import { randomBytes } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import type { CredentialSummary, CredentialValues } from '../../shared/credentials'
import {
  CredentialUses,
  credentialApprovalFor,
  credentialRequestsFor,
  type CredentialApproval,
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
    toolCallId: 'call-1',
    ...overrides
  })
  /** What the kernel does for a call it approved, then what the tool does when it runs. */
  const approvedTake = (use: CredentialUseRequest) => {
    uses.permit(use)
    return uses.take(use)
  }
  return {
    uses,
    record,
    setTransientSecrets,
    request,
    approvedTake,
    advance: (ms: number) => (clock += ms)
  }
}

describe('CredentialUses', () => {
  it('describes an in-scope use for its approval card, never its value', () => {
    const { uses, request } = setup()
    const approval = uses.approval(request()) as CredentialApproval
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

  it('refuses a use outside scope before anyone is asked, and records it', () => {
    const { uses, request, record } = setup()
    const elsewhere = request({ target: 'https://evil.example/collect' })
    expect(uses.approval(elsewhere)).toEqual({
      refused: expect.stringContaining('login.microsoftonline.com')
    })
    expect(record).toHaveBeenCalledWith(
      'refused',
      expect.objectContaining({ alias: 'partner-center' }),
      expect.objectContaining({ target: 'https://evil.example/collect' })
    )
    expect(credentialApprovalFor(uses, [request(), elsewhere])).toEqual({
      refused: expect.any(String)
    })
  })

  it('gives values only to a call the kernel approved, once', () => {
    const { uses, request, record } = setup()
    expect(uses.take(request())).toEqual({
      ok: false,
      message: expect.stringContaining('did not approve')
    })
    expect(record).toHaveBeenLastCalledWith('refused', expect.anything(), expect.anything())
    uses.permit(request())
    // A permit names the call, the alias and the address; another of any of them is not covered.
    expect(uses.take(request({ toolCallId: 'call-2' })).ok).toBe(false)
    expect(uses.take(request({ runId: 'run-2' })).ok).toBe(false)
    expect(uses.take(request({ target: 'https://login.microsoftonline.com/other' })).ok).toBe(false)
    expect(uses.take(request({ toolCallId: undefined })).ok).toBe(false)
    expect(uses.take(request()).ok).toBe(true)
    expect(uses.take(request()).ok).toBe(false)
  })

  it('checks scope again when an approved call runs', () => {
    const entries = [credential()]
    const { uses, request } = setup(entries)
    uses.permit(request())
    entries[0] = credential({ scope: { ...credential().scope, web: undefined } })
    expect(uses.take(request())).toMatchObject({
      ok: false,
      message: expect.stringContaining('may not be sent in web requests')
    })
  })

  it('lets the approvals a run did not use lapse when it ends', () => {
    const { uses, request } = setup()
    uses.permit(request())
    uses.releaseRun('run-1')
    expect(uses.take(request()).ok).toBe(false)
  })

  it.each([
    'http://login.microsoftonline.com/token',
    'https://login.microsoftonline.com:8443/token',
    'https://login.microsoftonline.com@evil.example/token',
    'not a url'
  ])('refuses %s', (target) => {
    const { uses, request, approvedTake } = setup()
    expect('refused' in uses.approval(request({ target }))).toBe(true)
    expect(approvedTake(request({ target })).ok).toBe(false)
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
    expect(uses.approval(request({ alias: 'missing' }))).toEqual({
      refused: expect.stringContaining('No credential')
    })
    expect(uses.approval(request({ alias: 'no-web' }))).toEqual({
      refused: expect.stringContaining('may not be sent in web requests')
    })
    expect(uses.approval(request({ alias: 'elsewhere' }))).toEqual({
      refused: expect.stringContaining("this chat's project")
    })
  })

  it('records a use by where it went, without the query string', () => {
    const { request, record, approvedTake } = setup()
    const taken = approvedTake(request({ target: 'https://login.microsoftonline.com/t?secret=x' }))
    expect(taken).toMatchObject({ ok: true, values: { secret: SECRET } })
    expect(record).toHaveBeenCalledWith(
      'used',
      expect.anything(),
      expect.objectContaining({ target: 'https://login.microsoftonline.com/t' })
    )
  })

  it('lets a returned token go only to token hosts, in the same run, until it expires', () => {
    const { uses, request, approvedTake, setTransientSecrets, advance } = setup()
    const token = randomBytes(24).toString('hex')
    const alias = uses.addDerived('partner-center', 'run-1', token, 120)
    expect(alias).toBe('partner-center~1')
    expect(setTransientSecrets).toHaveBeenLastCalledWith([{ alias, value: token }])
    const api = request({ alias, target: 'https://api.partner.microsoft.com/v1/products' })
    expect(approvedTake(api)).toMatchObject({
      ok: true,
      values: { secret: token },
      send: { as: 'header', name: 'Authorization', prefix: 'Bearer ' }
    })
    expect(approvedTake({ ...api, target: 'https://login.microsoftonline.com/x' }).ok).toBe(false)
    // Another run of the same chat, or a call with no run, cannot use it.
    expect(uses.approval({ ...api, runId: 'run-2' })).toEqual({
      refused: expect.stringContaining('not a token this reply received')
    })
    expect(approvedTake({ ...api, runId: undefined }).ok).toBe(false)
    advance(121_000)
    expect(approvedTake(api)).toMatchObject({
      ok: false,
      message: expect.stringContaining('expired')
    })
    // It stopped working, but it stays redacted until SideKick restarts.
    expect(setTransientSecrets).toHaveBeenLastCalledWith([{ alias, value: token }])
  })

  it('ends a run’s returned tokens with the run and keeps redacting them', () => {
    const { uses, request, approvedTake, setTransientSecrets } = setup()
    const mine = randomBytes(24).toString('hex')
    const theirs = randomBytes(24).toString('hex')
    const alias = uses.addDerived('partner-center', 'run-1', mine)
    const other = uses.addDerived('partner-center', 'run-2', theirs)
    uses.releaseRun('run-1')
    const api = request({ alias, target: 'https://api.partner.microsoft.com/v1/products' })
    expect(approvedTake(api).ok).toBe(false)
    expect(approvedTake({ ...api, alias: other, runId: 'run-2' })).toMatchObject({ ok: true })
    expect(setTransientSecrets).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        { alias, value: mine },
        { alias: other, value: theirs }
      ])
    )
  })

  it('will not keep a returned token without the run that received it', () => {
    const { uses } = setup()
    expect(() => uses.addDerived('partner-center', '', 'value')).toThrow()
  })

  it('combines several uses into one approval, asking as the strictest entry does', () => {
    const { uses, request } = setup([
      credential(),
      credential({ id: 'b', alias: 'other', ask: 'every_use' })
    ])
    const approval = credentialApprovalFor(uses, [
      request(),
      request({ alias: 'other' })
    ]) as CredentialApproval
    expect(approval.ask).toBe('every_use')
    expect(approval.keys).toHaveLength(2)
  })

  it('reads the credential from http_request arguments only', () => {
    expect(
      credentialRequestsFor(
        'http_request',
        { url: 'https://a.example', credential: ' partner-center ' },
        { conversationId: 'c', runId: 'r', toolCallId: 't' }
      )
    ).toEqual([
      {
        alias: 'partner-center',
        tool: 'http_request',
        kind: 'web',
        target: 'https://a.example',
        conversationId: 'c',
        runId: 'r',
        toolCallId: 't'
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
