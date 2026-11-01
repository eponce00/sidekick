import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { networkAddressKind } from '../../shared/browserNetwork'
import type { BrowserNetworkPolicy } from './browserNetworkApprovals'
import {
  admitWebUrl,
  getAdmitted,
  requestAdmitted,
  resolveAdmitted,
  webNetworkRefusal,
  WebNetworkRefusal,
  type WebNetworkOptions
} from './webNetworkGuard'

function policy(answer: boolean, approved: string[] = []): BrowserNetworkPolicy {
  return {
    approved: vi.fn((origin: string) => approved.includes(origin)),
    approve: vi.fn(async () => answer)
  }
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    const refused = webNetworkRefusal(error)
    if (refused) return refused.message
    throw error
  }
  throw new Error('The request was not refused')
}

describe('admitWebUrl', () => {
  it('never admits this computer, however it is written', async () => {
    for (const address of [
      'http://localhost:3000/',
      'https://localhost/',
      'http://127.0.0.1/',
      'http://127.1/',
      'http://2130706433/',
      'http://0x7f.0.0.1/',
      'http://0.0.0.0:9333/json',
      'http://[::1]:8080/',
      'https://[::]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[0:0:0:0:0:ffff:7f00:1]/'
    ]) {
      const ask = policy(true)
      expect(await refusal(admitWebUrl(new URL(address), { policy: ask })), address).toMatch(
        /on this computer/
      )
      expect(ask.approve).not.toHaveBeenCalled()
    }
  })

  it('asks before plain HTTP reaches a local-network origin, once approved asks no more', async () => {
    const run = new AbortController()
    const ask = policy(true)
    expect(
      await admitWebUrl(new URL('http://192.168.1.1/admin'), { policy: ask, signal: run.signal })
    ).toEqual({ allowLocal: true, reach: 'local' })
    expect(ask.approve).toHaveBeenCalledWith('http://192.168.1.1', run.signal)

    const approved = policy(false, ['http://printer.local:8080'])
    expect(
      await admitWebUrl(new URL('http://printer.local:8080/status'), { policy: approved })
    ).toEqual({ allowLocal: true })
    expect(approved.approve).not.toHaveBeenCalled()
  })

  it('refuses a local-network origin the user denied, or when nobody can be asked', async () => {
    expect(
      await refusal(admitWebUrl(new URL('http://192.168.1.1/'), { policy: policy(false) }))
    ).toBe(
      'The user did not allow SideKick to open http://192.168.1.1. Ask them before trying it again.'
    )
    for (const address of [
      'http://10.0.0.5/',
      'http://[fd00::5]/',
      'http://[::ffff:192.168.1.1]/',
      'http://nas/',
      'http://169.254.169.254/latest/meta-data/'
    ]) {
      expect(await refusal(admitWebUrl(new URL(address))), address).toMatch(/has not been allowed/)
    }
  })

  it('opens an HTTPS local-network origin as the browser does, its certificate vouching', async () => {
    const ask = policy(false)
    expect(await admitWebUrl(new URL('https://192.168.1.1/'), { policy: ask })).toEqual({
      allowLocal: true,
      reach: 'local'
    })
    expect(await admitWebUrl(new URL('https://nas.local/'), { policy: ask })).toEqual({
      allowLocal: true
    })
    expect(ask.approve).not.toHaveBeenCalled()
  })

  it('keeps a public name off the local network, over HTTP or HTTPS', async () => {
    for (const address of ['http://example.com/', 'https://example.com/']) {
      expect(await admitWebUrl(new URL(address)), address).toEqual({ allowLocal: false })
    }
    expect(await admitWebUrl(new URL('http://8.8.8.8/'))).toEqual({
      allowLocal: false,
      reach: 'public'
    })
  })

  it('never follows the internet into the local network, approved or not', async () => {
    const approved = policy(true, ['http://192.168.1.1'])
    for (const address of [
      'http://192.168.1.1/',
      'https://192.168.1.1/',
      'https://nas.local/',
      'http://[fe80::1]/'
    ]) {
      expect(
        await refusal(admitWebUrl(new URL(address), { policy: approved, from: 'public' })),
        address
      ).toMatch(/does not follow the internet into the local network/)
    }
    expect(await admitWebUrl(new URL('https://example.com/'), { from: 'public' })).toEqual({
      allowLocal: false
    })
    expect(approved.approve).not.toHaveBeenCalled()
  })

  it('lets a device redirect within what was approved, and never asks on a redirect', async () => {
    const ask = policy(true, ['http://192.168.1.1'])
    expect(
      await admitWebUrl(new URL('http://192.168.1.1/login'), { policy: ask, from: 'local' })
    ).toEqual({ allowLocal: true, reach: 'local' })
    expect(
      await refusal(admitWebUrl(new URL('http://192.168.1.2/'), { policy: ask, from: 'local' }))
    ).toMatch(/has not allowed/)
    expect(ask.approve).not.toHaveBeenCalled()
  })

  it('refuses the local network altogether for addresses nobody chose', async () => {
    for (const address of ['https://192.168.1.1/a.jpg', 'http://camera.local/snap.jpg']) {
      expect(
        await refusal(admitWebUrl(new URL(address), { localNetwork: false, policy: policy(true) })),
        address
      ).toMatch(/may not reach/)
    }
    expect(
      await admitWebUrl(new URL('https://images.example/a.jpg'), { localNetwork: false })
    ).toEqual({ allowLocal: false })
  })

  it('refuses other schemes and credentials', async () => {
    for (const address of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://10.0.0.1/']) {
      expect(await refusal(admitWebUrl(new URL(address))), address).toMatch(/Only HTTP and HTTPS/)
    }
    expect(await refusal(admitWebUrl(new URL('http://admin:admin@example.com/')))).toMatch(
      /user name or password/
    )
  })
})

describe('resolveAdmitted', () => {
  const resolving =
    (...addresses: string[]): WebNetworkOptions['resolve'] =>
    async () =>
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

  it('refuses a name that resolves to this computer, even where local addresses are allowed', async () => {
    for (const address of ['127.0.0.1', '::1', '0.0.0.0', '::ffff:127.0.0.1', '::']) {
      expect(
        await refusal(
          resolveAdmitted('sneaky.example', { allowLocal: true }, { resolve: resolving(address) })
        ),
        address
      ).toMatch(/on this computer/)
    }
  })

  it('refuses a name that resolves into the local network unless the request may go there', async () => {
    for (const address of ['10.0.0.1', '192.168.1.1', 'fe80::1', 'fd00::1', '::ffff:a00:1']) {
      expect(
        await refusal(
          resolveAdmitted('rebind.example', { allowLocal: false }, { resolve: resolving(address) })
        ),
        address
      ).toMatch(/into the local network/)
      expect(
        await resolveAdmitted('nas.example', { allowLocal: true }, { resolve: resolving(address) })
      ).toMatchObject({ reach: 'local' })
    }
  })

  it('checks every address, since a connection may use any of them', async () => {
    expect(
      await refusal(
        resolveAdmitted(
          'mixed.example',
          { allowLocal: false },
          { resolve: resolving('93.184.216.34', '2606:2800::1', '10.0.0.1') }
        )
      )
    ).toMatch(/into the local network/)
    expect(
      await resolveAdmitted(
        'example.com',
        { allowLocal: true },
        { resolve: resolving('93.184.216.34', '10.0.0.1') }
      )
    ).toMatchObject({ reach: 'public' })
  })

  it('refuses an address it cannot read rather than guess', async () => {
    expect(
      await refusal(
        resolveAdmitted('odd.example', { allowLocal: true }, { resolve: resolving('not-an-ip') })
      )
    ).toMatch(/on this computer/)
  })
})

/**
 * A server on this computer stands in for the internet: the tests classify 127.0.0.1 as public,
 * and resolve their own names, so what is refused is decided by the policy, never by the test's
 * own machine. Paths that should never be reached count their visits.
 */
describe('getAdmitted', () => {
  let server: Server
  let port = 0
  const hits: string[] = []

  const names: Record<string, string[]> = {}
  const network = (extra: WebNetworkOptions = {}): WebNetworkOptions => ({
    resolve: async (hostname) => {
      const addresses = names[hostname]
      if (!addresses)
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
          code: 'ENOTFOUND'
        })
      return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
    },
    addressKind: (address) => (address === '127.0.0.1' ? 'public' : networkAddressKind(address)),
    ...extra
  })

  beforeAll(async () => {
    server = createServer((request, response) => {
      hits.push(request.url ?? '')
      const redirects: Record<string, string> = {
        '/to-ip': 'http://192.168.1.1/admin',
        '/to-rebind': `http://rebind.test:${port}/secret`,
        '/to-mapped': `http://[::ffff:7f00:1]:${port}/secret`,
        '/to-localhost': `http://localhost:${port}/secret`,
        '/to-https-local': 'https://nas.local/secret',
        '/to-page': `http://public.test:${port}/page`,
        '/to-credentials': `http://user:pass@public.test:${port}/page`,
        '/to-file': 'file:///etc/passwd',
        '/loop': '/loop'
      }
      const target = redirects[request.url ?? '']
      if (target) {
        response.writeHead(302, { location: target }).end()
        return
      }
      if (request.url === '/trickle' || request.url === '/endless') {
        // Never quiet for long, so only a deadline or a byte cap ends it.
        response.writeHead(200, { 'content-type': 'text/plain' })
        const chunk = request.url === '/trickle' ? '.' : 'x'.repeat(64_000)
        const timer = setInterval(() => response.write(chunk), request.url === '/trickle' ? 50 : 1)
        response.on('close', () => clearInterval(timer))
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' }).end(`read ${request.url}`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(() => {
    server.closeAllConnections()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    hits.length = 0
    for (const name of Object.keys(names)) delete names[name]
    names['public.test'] = ['127.0.0.1']
  })

  const get = (path: string, extra?: WebNetworkOptions, host = 'public.test') =>
    getAdmitted<string>(
      new URL(`http://${host}:${port}${path}`),
      { responseType: 'text', timeout: 5_000 },
      network(extra)
    )

  it('connects to the address its own lookup admitted, and follows public redirects', async () => {
    const { url, response } = await get('/to-page')
    expect(response.data).toBe('read /page')
    expect(url.pathname).toBe('/page')
    expect(hits).toEqual(['/to-page', '/page'])
  })

  it('refuses a name that resolves into the local network before connecting', async () => {
    names['rebind.test'] = ['10.255.255.1']
    expect(await refusal(get('/secret', {}, 'rebind.test'))).toMatch(/into the local network/)
    expect(hits).toEqual([])
  })

  it('refuses a name that resolves to this computer, connecting nowhere', async () => {
    names['rebind.test'] = ['::1', '127.0.0.2']
    expect(await refusal(get('/secret', {}, 'rebind.test'))).toMatch(/on this computer/)
    expect(hits).toEqual([])
  })

  it('checks every redirect before following it', async () => {
    names['rebind.test'] = ['10.255.255.1']
    names['nas.local'] = ['10.255.255.2']
    const approved = policy(true, ['http://192.168.1.1'])
    for (const [path, reason] of [
      ['/to-ip', /internet into the local network/],
      ['/to-rebind', /name on the internet lead into the local network/],
      ['/to-https-local', /internet into the local network/],
      ['/to-mapped', /on this computer/],
      ['/to-localhost', /on this computer/],
      ['/to-credentials', /user name or password/],
      ['/to-file', /Only HTTP and HTTPS/]
    ] as const) {
      expect(await refusal(get(path, { policy: approved })), path).toMatch(reason)
    }
    expect(hits.filter((path) => !path.startsWith('/to-'))).toEqual([])
    expect(approved.approve).not.toHaveBeenCalled()
  })

  it('stops a redirect loop', async () => {
    await expect(get('/loop')).rejects.toThrow(/redirected more than 5 times/)
    expect(hits).toHaveLength(6)
  })

  it('reaches an approved device by its local name, and asks first', async () => {
    names['printer.local'] = ['127.0.0.1']
    const ask = policy(true)
    const { response } = await get('/status', { policy: ask }, 'printer.local')
    expect(response.data).toBe('read /status')
    expect(ask.approve).toHaveBeenCalledWith(`http://printer.local:${port}`, undefined)

    const deny = policy(false)
    expect(await refusal(get('/status', { policy: deny }, 'printer.local'))).toMatch(
      /did not allow/
    )
    expect(hits).toEqual(['/status'])
  })

  it('ignores proxy settings, which would connect to addresses it never checked', async () => {
    const saved = { http: process.env.HTTP_PROXY, all: process.env.ALL_PROXY }
    process.env.HTTP_PROXY = 'http://127.0.0.1:9'
    process.env.ALL_PROXY = 'http://127.0.0.1:9'
    try {
      const { response } = await get('/page')
      expect(response.data).toBe('read /page')
    } finally {
      for (const [key, value] of [
        ['HTTP_PROXY', saved.http],
        ['ALL_PROXY', saved.all]
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('ends a response that keeps trickling past its deadline, or outgrows its byte cap', async () => {
    const started = Date.now()
    const slow = await getAdmitted(
      new URL(`http://public.test:${port}/trickle`),
      { responseType: 'text', timeout: 300 },
      network()
    ).catch((caught: unknown) => caught)
    expect(slow).toMatchObject({ name: 'WebResponseLimit', limit: 'time' })
    expect(Date.now() - started).toBeLessThan(3_000)

    const large = await getAdmitted(
      new URL(`http://public.test:${port}/endless`),
      { responseType: 'arraybuffer', timeout: 5_000, maxContentLength: 200_000 },
      network()
    ).catch((caught: unknown) => caught)
    expect(large).toMatchObject({ name: 'WebResponseLimit', limit: 'size' })
    expect((large as Error).message).toMatch(/larger than 200 KB/)
  })

  it('keeps the refusal recognisable through the HTTP client', async () => {
    names['rebind.test'] = ['10.255.255.1']
    const error = await get('/secret', {}, 'rebind.test').catch((caught: unknown) => caught)
    expect(error).not.toBeInstanceOf(WebNetworkRefusal)
    expect(webNetworkRefusal(error)).toBeInstanceOf(WebNetworkRefusal)
  })
})

describe('requestAdmitted', () => {
  let server: Server
  let port = 0
  const hits: string[] = []
  const trickles = new Set<NodeJS.Timeout>()
  const names: Record<string, string[]> = { 'public.test': ['127.0.0.1'] }
  const network = (extra: WebNetworkOptions = {}): WebNetworkOptions => ({
    resolve: async (hostname) =>
      (names[hostname] ?? []).map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4
      })),
    addressKind: (address) => (address === '127.0.0.1' ? 'public' : networkAddressKind(address)),
    ...extra
  })

  beforeAll(async () => {
    server = createServer((request, response) => {
      hits.push(`${request.method} ${request.url}`)
      if (request.url === '/redirect') {
        response.writeHead(302, { location: `http://public.test:${port}/landed` }).end()
        return
      }
      if (request.url === '/trickle') {
        // A reply that never goes quiet for long, so only a deadline for the whole exchange ends it.
        response.writeHead(200, { 'content-type': 'text/plain' })
        const timer = setInterval(() => response.write('.'), 50)
        trickles.add(timer)
        response.on('close', () => clearInterval(timer))
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' }).end(`read ${request.url}`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(() => {
    for (const timer of trickles) clearInterval(timer)
    server.closeAllConnections()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    hits.length = 0
  })

  it('hands back a redirect instead of following it', async () => {
    const response = await requestAdmitted<string>(
      new URL(`http://public.test:${port}/redirect`),
      { method: 'POST', data: 'x', responseType: 'text' },
      network()
    )
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe(`http://public.test:${port}/landed`)
    expect(hits).toEqual(['POST /redirect'])
  })

  it('refuses a name that resolves into the local network or to this computer', async () => {
    names['rebind.test'] = ['10.255.255.1']
    names['loop.test'] = ['::1']
    expect(
      await refusal(
        requestAdmitted(new URL(`http://rebind.test:${port}/secret`), { method: 'GET' }, network())
      )
    ).toMatch(/into the local network/)
    expect(
      await refusal(
        requestAdmitted(new URL(`http://loop.test:${port}/secret`), { method: 'GET' }, network())
      )
    ).toMatch(/on this computer/)
    expect(hits).toEqual([])
  })

  it('never reaches this computer by its loopback address', async () => {
    const ask = policy(true)
    for (const address of [`http://127.0.0.1:${port}/x`, `http://localhost:${port}/x`]) {
      expect(
        await refusal(requestAdmitted(new URL(address), { method: 'GET' }, { policy: ask }))
      ).toMatch(/on this computer/)
    }
    expect(ask.approve).not.toHaveBeenCalled()
    expect(hits).toEqual([])
  })

  it('stops a reply that trickles past the deadline', async () => {
    const started = Date.now()
    const error = await requestAdmitted(
      new URL(`http://public.test:${port}/trickle`),
      { method: 'GET', timeout: 300, responseType: 'text' },
      network()
    ).catch((caught: unknown) => caught)
    expect((error as { code?: string }).code).toBe('ERR_CANCELED')
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})
