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
  const uses = new CredentialUses(store, () => clock)
  const request = (overrides: Partial<CredentialUseRequest> = {}): CredentialUseRequest => ({
    alias: 'partner-center',
    tool: 'http_request',
    kind: 'web',
    target: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
    placement: { as: 'form', name: 'client_secret' },
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
  it('describes a use for its approval card, never its value, with one chat grant per entry', () => {
    const { uses, request } = setup()
    const approval = uses.approval(request()) as CredentialApproval
    expect(approval).toMatchObject({
      alias: 'partner-center',
      keys: ['credential:pc'],
      label: 'partner-center in this chat'
    })
    expect(approval.preview.facts).toContainEqual({
      label: 'How',
      value: 'as the client_secret form field'
    })
    expect(
      (uses.approval(request({ placement: undefined })) as CredentialApproval).preview.facts
    ).toContainEqual({ label: 'How', value: 'in the Authorization header after "Bearer"' })
    expect(JSON.stringify(approval)).not.toContain(SECRET)
  })

  it.each([
    'http://login.microsoftonline.com/token',
    'https://user@login.microsoftonline.com/token',
    'not a url'
  ])('refuses to send a value to %s, before anyone is asked, and records it', (target) => {
    const { uses, request, record, approvedTake } = setup()
    expect(uses.approval(request({ target }))).toEqual({ refused: expect.any(String) })
    expect(record).toHaveBeenCalledWith('refused', expect.anything(), expect.anything())
    expect(approvedTake(request({ target })).ok).toBe(false)
    expect(credentialApprovalFor(uses, [request(), request({ target })])).toEqual({
      refused: expect.any(String)
    })
  })

  it('sends over plain HTTP only to a server on this computer', () => {
    const { uses, request } = setup()
    expect('refused' in uses.approval(request({ target: 'http://localhost:3000/api' }))).toBe(false)
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

  it('lets the approvals a run did not use lapse when it ends', () => {
    const { uses, request } = setup()
    uses.permit(request())
    uses.releaseRun('run-1')
    expect(uses.take(request()).ok).toBe(false)
  })

  it('refuses an unknown alias, an entry this computer cannot read, and a bad placement', () => {
    const { uses, request } = setup([credential({ alias: 'moved', id: 'm', needsValue: true })])
    expect(uses.approval(request({ alias: 'missing' }))).toEqual({
      refused: expect.stringContaining('No credential')
    })
    expect(uses.approval(request({ alias: 'moved' }))).toEqual({
      refused: expect.stringContaining('entered again')
    })
    const { uses: other, request: otherRequest } = setup()
    expect(other.approval(otherRequest({ placement: { as: 'header', name: 'Host' } }))).toEqual({
      refused: expect.any(String)
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

  it('lets a returned token go only to web requests of the same run, until it expires', () => {
    const { uses, request, approvedTake, setTransientSecrets, advance } = setup()
    const token = randomBytes(24).toString('hex')
    const alias = uses.addDerived('partner-center', 'run-1', token, 120)
    expect(alias).toBe('partner-center~1')
    expect(setTransientSecrets).toHaveBeenLastCalledWith([{ alias, value: token }])
    const api = request({ alias, target: 'https://api.partner.microsoft.com/v1/products' })
    expect(approvedTake(api)).toMatchObject({ ok: true, values: { secret: token }, derived: true })
    expect(approvedTake({ ...api, target: 'http://api.partner.microsoft.com/x' }).ok).toBe(false)
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

  it('combines several uses into one approval whose grant covers each entry', () => {
    const { uses, request } = setup([credential(), credential({ id: 'b', alias: 'other' })])
    const approval = credentialApprovalFor(uses, [
      request(),
      request({ alias: 'other' })
    ]) as CredentialApproval
    expect(approval.keys).toEqual(['credential:pc', 'credential:b'])
  })

  it('reads the credential and its placement from http_request arguments only', () => {
    expect(
      credentialRequestsFor(
        'http_request',
        {
          url: 'https://a.example',
          credential: ' partner-center ',
          credential_as: { as: 'query', name: 'key' }
        },
        { conversationId: 'c', runId: 'r', toolCallId: 't' }
      )
    ).toEqual([
      {
        alias: 'partner-center',
        tool: 'http_request',
        kind: 'web',
        target: 'https://a.example',
        placement: { as: 'query', name: 'key' },
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

  describe('commands', () => {
    const command = (overrides: Partial<CredentialUseRequest> = {}): CredentialUseRequest => ({
      alias: 'partner-center',
      tool: 'shell',
      kind: 'command',
      target: 'gh api /user',
      variable: 'GH_TOKEN',
      conversationId: 'chat-1',
      runId: 'run-1',
      toolCallId: 'call-1',
      ...overrides
    })

    it('shows the command and variable, and binds the permit to both', () => {
      const { uses, record, approvedTake } = setup()
      const approval = uses.approval(
        command({ target: 'curl https://x.example' })
      ) as CredentialApproval
      expect(approval.preview.facts).toEqual(
        expect.arrayContaining([
          { label: 'Variable', value: 'GH_TOKEN' },
          { label: 'Command', value: 'curl https://x.example' }
        ])
      )
      expect(approvedTake(command())).toMatchObject({ ok: true, values: { secret: SECRET } })
      expect(record).toHaveBeenLastCalledWith(
        'used',
        expect.anything(),
        expect.objectContaining({ target: 'gh api /user', detail: 'In GH_TOKEN' })
      )
      uses.permit(command())
      expect(uses.take(command({ variable: 'OTHER' })).ok).toBe(false)
      expect(uses.take(command({ target: 'gh api /user/keys' })).ok).toBe(false)
    })

    it('refuses a variable that changes how commands run before anyone is asked', () => {
      const { uses } = setup()
      expect(uses.approval(command({ variable: 'PATH' }))).toEqual({
        refused: expect.stringContaining('changes how commands run')
      })
      expect(uses.approval(command({ variable: 'NODE_OPTIONS' }))).toMatchObject({
        refused: expect.any(String)
      })
    })

    it('never puts a returned token in a command', () => {
      const { uses, approvedTake } = setup()
      const alias = uses.addDerived('partner-center', 'run-1', randomBytes(8).toString('hex'))
      expect(uses.approval(command({ alias }))).toEqual({
        refused: expect.stringContaining('only in web requests')
      })
      expect(approvedTake(command({ alias })).ok).toBe(false)
    })

    it('reads each secret a shell call names', () => {
      expect(
        credentialRequestsFor(
          'shell',
          { command: 'gh api /user', secrets: { GH_TOKEN: 'gh-token', USER: 'site.username' } },
          { conversationId: 'c' }
        )
      ).toEqual([
        expect.objectContaining({ alias: 'gh-token', kind: 'command', variable: 'GH_TOKEN' }),
        expect.objectContaining({ alias: 'site', kind: 'command', variable: 'USER' })
      ])
    })
  })

  describe('browser sign-in', () => {
    const site = credential({
      id: 'site',
      alias: 'site-login',
      kind: 'sign_in',
      username: 'visible-user'
    })
    const page = (target: string, alias = 'site-login'): CredentialUseRequest => ({
      alias,
      tool: 'browser_sign_in',
      kind: 'browser',
      target,
      conversationId: 'chat-1',
      runId: 'run-1',
      toolCallId: 'call-1'
    })

    it('names the site and account on its card', () => {
      const { uses } = setup([site])
      const approval = uses.approval(
        page('https://login.example.com/sign-in?next=/home')
      ) as CredentialApproval
      expect(approval.keys).toEqual(['credential:site'])
      expect(approval.preview.facts).toEqual(
        expect.arrayContaining([
          { label: 'As', value: 'visible-user' },
          { label: 'On', value: 'https://login.example.com' }
        ])
      )
    })

    it.each(['http://login.example.com/', 'about:blank', ''])('refuses to fill on %j', (target) => {
      const { uses, approvedTake } = setup([site])
      expect('refused' in uses.approval(page(target))).toBe(true)
      expect(approvedTake(page(target)).ok).toBe(false)
    })

    it('refuses a credential with no username', () => {
      const { uses } = setup([site, credential()])
      expect(uses.approval(page('https://login.example.com/', 'partner-center'))).toEqual({
        refused: expect.stringContaining('no username')
      })
    })

    it('approves a sign-in for the page’s origin, not one path on it', () => {
      const { uses } = setup([site])
      uses.permit(page('https://login.example.com/sign-in'))
      expect(uses.take(page('https://other.example.com/sign-in')).ok).toBe(false)
      expect(uses.take(page('https://login.example.com/sign-in/password')).ok).toBe(true)
    })

    it('reads a sign-in request with the page the browser is on', () => {
      expect(
        credentialRequestsFor(
          'browser_sign_in',
          { credential: 'site-login' },
          { conversationId: 'c' },
          'https://login.example.com/'
        )
      ).toEqual([
        expect.objectContaining({ kind: 'browser', target: 'https://login.example.com/' })
      ])
    })
  })
})
