import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AxiosRequestConfig } from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialSend, CredentialSummary } from '../../shared/credentials'
import { registerHttpToolHandlers, type HttpSend } from './agentHttpToolHandlers'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import { CredentialRedactor } from './credentialRedaction'
import { CredentialUses, credentialRequestsFor } from './credentialUses'
import { ToolOutputStore } from './toolOutputStore'

const SECRET = `gen${randomBytes(16).toString('hex')}`
const USERNAME = `user${randomBytes(4).toString('hex')}`
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function credential(kind: CredentialSummary['kind'] = 'secret') {
  return {
    id: 'one',
    alias: 'api-key',
    kind,
    description: '',
    createdAt: 1,
    updatedAt: 1,
    needsValue: false
  }
}

function setup(
  send: CredentialSend = { as: 'header', name: 'Authorization', prefix: 'Bearer ' },
  kind: CredentialSummary['kind'] = 'secret',
  response: {
    status?: number
    contentType?: string
    body?: string | Buffer
    headers?: Record<string, string>
  } = {}
) {
  const redactor = new CredentialRedactor()
  redactor.setSecrets([
    { alias: 'api-key', value: SECRET },
    { alias: 'api-key', value: USERNAME }
  ])
  const entry = credential(kind)
  const record = vi.fn()
  const uses = new CredentialUses({
    list: () => [entry],
    resolve: () => ({
      summary: entry,
      values: kind === 'secret' ? { secret: SECRET } : { username: USERNAME, password: SECRET }
    }),
    record,
    setTransientSecrets: (secrets) =>
      redactor.setSecrets([
        { alias: 'api-key', value: SECRET },
        ...secrets.map(({ alias, value }) => ({ alias, value }))
      ])
  })
  const sent: Array<{ url: URL; config: AxiosRequestConfig }> = []
  const transport = vi.fn<HttpSend>(async (url, config) => {
    sent.push({ url: new URL(url.href), config })
    const body = Buffer.isBuffer(response.body)
      ? response.body
      : Buffer.from(response.body ?? '{"ok":true}')
    return {
      status: response.status ?? 200,
      statusText: 'OK',
      headers: { 'content-type': response.contentType ?? 'application/json', ...response.headers },
      data: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      config: {} as never
    }
  })
  const dir = mkdtempSync(join(tmpdir(), 'sidekick-http-'))
  dirs.push(dir)
  const handlers = new AgentToolHandlerRegistry()
  registerHttpToolHandlers(handlers, {
    outputs: new ToolOutputStore(dir, Date.now, redactor),
    credentials: () => uses,
    send: transport
  })
  let calls = 0
  /**
   * Runs a call as the kernel does: credential uses it approved get a permit first. A call that
   * names a stored credential says it goes where `send` puts it, in the tool's own words.
   */
  const call = (
    raw: Record<string, unknown>,
    { runId = 'run', approved = true }: { runId?: string; approved?: boolean } = {}
  ) => {
    const { usernameName, ...placement } = send as CredentialSend & { usernameName?: string }
    const args =
      raw.credential === 'api-key' && raw.credential_as === undefined
        ? {
            ...raw,
            credential_as: {
              ...placement,
              ...(usernameName ? { username_name: usernameName } : {})
            }
          }
        : raw
    const context = { runId, conversationId: 'chat', toolCallId: `call-${++calls}` }
    if (approved) {
      for (const request of credentialRequestsFor('http_request', args, context)) {
        uses.permit(request)
      }
    }
    return handlers.execute({
      name: 'http_request',
      title: 'Request',
      arguments: args,
      context: { ...context, signal: new AbortController().signal }
    })
  }
  return { call, sent, transport, record, redactor, uses }
}

describe('http_request', () => {
  it('adds a header credential for its host, and the result never holds the value', async () => {
    const { call, sent } = setup(undefined, 'secret', {
      body: JSON.stringify({ echoed: `Bearer ${SECRET}` })
    })
    const result = await call({
      method: 'GET',
      url: 'https://api.example.com/v1/items',
      credential: 'api-key'
    })
    expect(result.status).toBe('success')
    expect((sent[0].config.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${SECRET}`
    )
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(result.modelContent).toContain('[secret: api-key]')
  })

  it('sends a sign-in as Basic authentication', async () => {
    const { call, sent } = setup({ as: 'basic' }, 'sign_in')
    await call({ method: 'GET', url: 'https://api.example.com/', credential: 'api-key' })
    expect((sent[0].config.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from(`${USERNAME}:${SECRET}`).toString('base64')}`
    )
  })

  it('places a value as a query parameter, a form field or a JSON field', async () => {
    const query = setup({ as: 'query', name: 'key' })
    await query.call({ method: 'GET', url: 'https://api.example.com/x?a=1', credential: 'api-key' })
    expect(query.sent[0].url.searchParams.get('key')).toBe(SECRET)

    const form = setup({ as: 'form', name: 'client_secret' })
    await form.call({
      method: 'POST',
      url: 'https://api.example.com/token',
      form: { grant_type: 'client_credentials' },
      credential: 'api-key'
    })
    expect(new URLSearchParams(String(form.sent[0].config.data)).get('client_secret')).toBe(SECRET)
    expect((form.sent[0].config.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded'
    )

    const json = setup({ as: 'json', name: 'password', usernameName: 'user' }, 'sign_in')
    await json.call({
      method: 'POST',
      url: 'https://api.example.com/login',
      json: { remember: true },
      credential: 'api-key'
    })
    expect(JSON.parse(String(json.sent[0].config.data))).toEqual({
      remember: true,
      password: SECRET,
      user: USERNAME
    })
  })

  it('refuses to let the model set where the value goes itself', async () => {
    const { call, transport, record } = setup()
    const result = await call({
      method: 'GET',
      url: 'https://api.example.com/',
      headers: { authorization: 'Bearer something' },
      credential: 'api-key'
    })
    expect(result.status).toBe('error')
    expect(result.error?.message).toContain('Leave out the Authorization header')
    expect(transport).not.toHaveBeenCalled()
    // Audited as used, though nothing was sent.
    expect(record.mock.calls.map(([kind]) => kind)).toEqual(['refused'])

    await call({ method: 'GET', url: 'https://api.example.com/', credential: 'api-key' })
    expect(record.mock.calls.map(([kind]) => kind)).toEqual(['refused', 'used'])
  })

  // A server that reads the model's copy of a field and echoes it would answer with the value.
  it.each([
    [{ as: 'query', name: 'key' }, { url: 'https://api.example.com/x?KEY=mine' }, 'KEY'],
    [{ as: 'query', name: 'key' }, { url: 'https://api.example.com/x?k%45y=mine' }, 'kEy'],
    [
      { as: 'form', name: 'client_secret' },
      { method: 'POST', form: { Client_Secret: 'mine' } },
      'Client_Secret'
    ],
    [
      { as: 'json', name: 'password', usernameName: 'user' },
      { method: 'POST', json: { USER: 'mine' } },
      'USER'
    ],
    [
      { as: 'form', name: 'client_secret' },
      { method: 'POST', form: {}, headers: { 'content-type': 'text/plain' } },
      'Content-Type'
    ],
    [
      { as: 'json', name: 'password' },
      {
        method: 'POST',
        json: {},
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      },
      'Content-Type'
    ],
    [
      { as: 'header', name: 'X-Api-Key', prefix: '' },
      { headers: { 'content-encoding': 'gzip' } },
      'Content-Encoding'
    ]
  ] as const)(
    'refuses a request that sets the credential’s place itself: %j %j',
    async (send, args, name) => {
      // A sign-in sent in a body names its username field too.
      const kind = 'usernameName' in send ? 'sign_in' : 'secret'
      const { call, transport } = setup(send as CredentialSend, kind)
      const result = await call({
        method: 'GET',
        url: 'https://api.example.com/x',
        ...args,
        credential: 'api-key'
      })
      expect(result.status).toBe('error')
      expect(result.error?.message).toContain(name)
      expect(transport).not.toHaveBeenCalled()
    }
  )

  it('sends nothing for a call the kernel did not approve', async () => {
    const { call, transport } = setup()
    const result = await call(
      { method: 'GET', url: 'https://api.example.com/', credential: 'api-key' },
      { approved: false }
    )
    expect(result.status).toBe('denied')
    expect(result.error?.message).toContain('did not approve')
    expect(transport).not.toHaveBeenCalled()
  })

  it('refuses a credential over plain HTTP without sending anything', async () => {
    const { call, transport, record } = setup()
    const result = await call({
      method: 'POST',
      url: 'http://api.example.com/collect',
      credential: 'api-key'
    })
    expect(result.status).toBe('denied')
    expect(transport).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledWith('refused', expect.anything(), expect.anything())
  })

  it('turns returned tokens into aliases usable only over HTTPS in the same reply', async () => {
    const token = randomBytes(24).toString('hex')
    const { call, sent } = setup({ as: 'form', name: 'client_secret' }, 'secret', {
      body: JSON.stringify({ token_type: 'Bearer', expires_in: 3600, access_token: token })
    })
    const exchange = await call({
      method: 'POST',
      url: 'https://api.example.com/token',
      form: { grant_type: 'client_credentials' },
      credential: 'api-key'
    })
    expect(exchange.modelContent).toContain('"access_token": "api-key~1"')
    expect(JSON.stringify(exchange)).not.toContain(token)

    const api = await call({
      method: 'GET',
      url: 'https://data.example.com/v1/products',
      credential: 'api-key~1'
    })
    expect(api.status).toBe('success')
    expect((sent[1].config.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`)
    const leak = await call({
      method: 'GET',
      url: 'http://data.example.com/v1',
      credential: 'api-key~1'
    })
    expect(leak.status).toBe('denied')
    const later = await call(
      { method: 'GET', url: 'https://data.example.com/v1/products', credential: 'api-key~1' },
      { runId: 'next-run' }
    )
    expect(later.status).toBe('denied')
  })

  const exchange = async (response: Parameters<typeof setup>[2]) => {
    const { call } = setup({ as: 'form', name: 'client_secret' }, 'secret', response)
    return call({
      method: 'POST',
      url: 'https://api.example.com/token',
      form: { grant_type: 'client_credentials' },
      credential: 'api-key'
    })
  }

  it.each([
    [
      'a form-encoded body',
      'application/x-www-form-urlencoded',
      (t: string) => `access_token=${t}&token_type=bearer`
    ],
    [
      'form encoding sent as plain text',
      'text/plain',
      (t: string) => `access_token=${t}&scope=repo`
    ],
    ['another name', 'application/json', (t: string) => JSON.stringify({ accessToken: t })],
    [
      'a client token',
      'application/json',
      (t: string) => JSON.stringify({ auth: { client_token: t } })
    ],
    [
      'a session token',
      'application/json',
      (t: string) => JSON.stringify({ data: { sessionToken: t } })
    ],
    [
      'deep nesting',
      'application/json',
      (t: string) => {
        let value: unknown = { token: t }
        for (let depth = 0; depth < 12; depth++) value = { level: [value] }
        return JSON.stringify(value)
      }
    ],
    [
      'an object under a token name',
      'application/json',
      (t: string) => JSON.stringify({ token: { value: t } })
    ],
    [
      'a byte-order mark',
      'application/json',
      (t: string) => `\uFEFF${JSON.stringify({ id_token: t })}`
    ],
    [
      'a JSON body without a JSON type',
      'text/plain',
      (t: string) => JSON.stringify({ refresh_token: t })
    ]
  ])('replaces a returned token in %s', async (_label, contentType, body) => {
    const token = randomBytes(24).toString('hex')
    const result = await exchange({ contentType, body: body(token) })
    expect(result.status).toBe('success')
    expect(JSON.stringify(result)).not.toContain(token)
    expect(result.modelContent).toContain('api-key~1')
  })

  it('reads a body in its declared charset or by its byte-order mark', async () => {
    const token = randomBytes(24).toString('hex')
    const json = JSON.stringify({ access_token: token })
    for (const response of [
      { contentType: 'application/json; charset=utf-16le', body: Buffer.from(json, 'utf16le') },
      {
        contentType: 'application/json',
        body: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')])
      }
    ]) {
      const result = await exchange(response)
      expect(result.modelContent).toContain('"access_token": "api-key~1"')
      expect(result.modelContent).not.toContain(token.slice(0, 12))
    }
  })

  it('replaces a token in a redirect’s query and fragment', async () => {
    const token = randomBytes(24).toString('hex')
    const code = randomBytes(16).toString('hex')
    const result = await exchange({
      status: 302,
      contentType: 'text/html',
      body: '',
      headers: {
        location: `https://app.example.com/callback?code=${code}#access_token=${token}&token_type=bearer&expires_in=60`
      }
    })
    expect(result.status).toBe('success')
    const shown = JSON.stringify(result)
    expect(shown).not.toContain(token)
    expect(shown).not.toContain(code)
    expect(result.modelContent).toMatch(
      /location: https:\/\/app\.example\.com\/callback\?code=api-key~\d#access_token=api-key~\d&token_type=bearer/
    )
  })

  it.each([
    [
      'XML',
      'application/xml',
      (t: string) => `<Credentials><SessionToken>${t}</SessionToken></Credentials>`
    ],
    [
      'HTML',
      'text/html',
      (t: string) => `<form><input type="hidden" name="csrf_token" value="${t}"></form>`
    ],
    ['a script', 'text/html', (t: string) => `<script>var access_token = "${t}";</script>`],
    ['broken JSON', 'application/json', (t: string) => `{"access_token": "${t}"`],
    ['undeclared UTF-16', 'text/plain', (t: string) => Buffer.from(`token: ${t}`, 'utf16le')],
    [
      'a number of tokens no exchange returns',
      'application/json',
      (t: string) =>
        JSON.stringify({ tokens: Array.from({ length: 40 }, (_, index) => `${t}${index}`) })
    ]
  ])('withholds %s it cannot replace tokens in', async (_label, contentType, body) => {
    const token = randomBytes(24).toString('hex')
    const result = await exchange({ contentType, body: body(token) })
    expect(result.status).toBe('success')
    expect(result.modelContent).toContain('SideKick withheld the response body')
    expect(JSON.stringify(result)).not.toContain(token.slice(0, 12))
  })

  it('leaves paging cursors and ordinary fields readable', async () => {
    const cursor = randomBytes(24).toString('hex')
    const result = await exchange({
      body: JSON.stringify({ items: [{ name: 'a', token_type: 'Bearer' }], nextPageToken: cursor })
    })
    expect(result.modelContent).toContain(cursor)
    expect(result.data).not.toHaveProperty('tokens')
  })

  it.each([
    [{ method: 'GET', url: 'https://api.example.com/', body: 'x' }, 'carry no body'],
    [{ method: 'POST', url: 'https://api.example.com/', body: 'x', json: {} }, 'at most one'],
    [
      { method: 'GET', url: 'https://api.example.com/', headers: { 'X-A': 'b\r\nC: d' } },
      'line break'
    ],
    [{ method: 'GET', url: 'https://api.example.com/', headers: { Host: 'evil.example' } }, 'Host'],
    [{ method: 'GET', url: 'file:///etc/passwd' }, 'http or https'],
    [{ method: 'TRACE', url: 'https://api.example.com/' }, 'method']
  ])('refuses %j', async (args, message) => {
    const { call, transport } = setup()
    const result = await call(args)
    expect(result.status).toBe('error')
    expect(result.error?.message).toContain(message)
    expect(transport).not.toHaveBeenCalled()
  })

  it('reports a failed request by its message alone', async () => {
    const failing = vi.fn<HttpSend>(async () => {
      const error = new Error('connect ETIMEDOUT') as Error & { config?: unknown }
      error.config = { headers: { Authorization: `Bearer ${SECRET}` } }
      throw error
    })
    const handlers = new AgentToolHandlerRegistry()
    const dir = mkdtempSync(join(tmpdir(), 'sidekick-http-'))
    dirs.push(dir)
    registerHttpToolHandlers(handlers, { outputs: new ToolOutputStore(dir), send: failing })
    const result = await handlers.execute({
      name: 'http_request',
      title: 'Request',
      arguments: { method: 'GET', url: 'https://api.example.com/' },
      context: { runId: 'run', signal: new AbortController().signal }
    })
    expect(result.error?.message).toBe('The request failed: connect ETIMEDOUT')
  })
})
