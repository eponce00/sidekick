import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const render = vi.hoisted(() => ({ attempts: 0 }))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: {
    fromPartition: () => {
      render.attempts++
      throw new Error('Rendering is not available in tests')
    }
  }
}))

import { networkAddressKind } from '../../../shared/browserNetwork'
import type { BrowserNetworkPolicy } from '../browserNetworkApprovals'
import type { WebNetworkOptions } from '../webNetworkGuard'
import { readPage, renderRequestAllowed, renderResponseAllowed } from './pageReader'

function policy(answer: boolean): BrowserNetworkPolicy {
  return { approved: vi.fn(() => false), approve: vi.fn(async () => answer) }
}

/** As in the guard's tests, a server on this computer stands in for one on the internet. */
describe('readPage under the local-network rules', () => {
  let server: Server
  let port = 0
  const hits: string[] = []
  const names: Record<string, string> = {}
  const network = (extra: WebNetworkOptions = {}): WebNetworkOptions => ({
    resolve: async (hostname) => {
      const address = names[hostname]
      if (!address) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`)
      return [{ address, family: address.includes(':') ? 6 : 4 }]
    },
    addressKind: (address) => (address === '127.0.0.1' ? 'public' : networkAddressKind(address)),
    ...extra
  })

  beforeAll(async () => {
    server = createServer((request, response) => {
      hits.push(request.url ?? '')
      if (request.url === '/to-router') {
        response.writeHead(302, { location: 'http://192.168.1.1/' }).end()
      } else if (request.url === '/to-rebind') {
        response.writeHead(301, { location: `http://rebind.test:${port}/admin` }).end()
      } else if (request.url === '/forbidden') {
        response.writeHead(403).end()
      } else if (request.url === '/windows-1252') {
        response
          .writeHead(200, { 'content-type': 'text/html; charset=windows-1252' })
          .end(Buffer.from('<html><body><p>Café » menu</p></body></html>', 'latin1'))
      } else if (request.url === '/shift-jis') {
        // 日本 in Shift_JIS, named only by the page's meta tag.
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            Buffer.concat([
              Buffer.from('<html><head><meta charset="shift_jis"></head><body><p>'),
              Buffer.from([0x93, 0xfa, 0x96, 0x7b]),
              Buffer.from('</p></body></html>')
            ])
          )
      } else {
        response.writeHead(200, { 'content-type': 'text/plain' }).end('router settings')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  beforeEach(() => {
    hits.length = 0
    render.attempts = 0
    for (const name of Object.keys(names)) delete names[name]
    names['public.test'] = '127.0.0.1'
    names['rebind.test'] = '192.168.1.1'
  })

  it('asks before reading a plain-HTTP device, and reads nothing when the user says no', async () => {
    const run = new AbortController()
    const deny = policy(false)
    const page = await readPage(
      'http://192.168.1.1/',
      undefined,
      network({ policy: deny, signal: run.signal })
    )
    expect(page).toMatchObject({ success: false, refused: true })
    expect(page.error).toMatch(/did not allow SideKick to open http:\/\/192\.168\.1\.1/)
    expect(deny.approve).toHaveBeenCalledWith('http://192.168.1.1', run.signal)
    expect(render.attempts).toBe(0)
  })

  it('reads an approved device', async () => {
    names['router.lan'] = '127.0.0.1'
    const allow = policy(true)
    const page = await readPage(`http://router.lan:${port}/`, undefined, network({ policy: allow }))
    expect(page).toMatchObject({ success: true, content: 'router settings' })
    expect(allow.approve).toHaveBeenCalledWith(`http://router.lan:${port}`, undefined)
  })

  it('refuses this computer without asking, connecting, or rendering', async () => {
    const ask = policy(true)
    for (const address of [
      `http://localhost:${port}/`,
      `http://127.0.0.1:${port}/`,
      `http://[::ffff:127.0.0.1]:${port}/`
    ]) {
      const page = await readPage(address, undefined, network({ policy: ask }))
      expect(page, address).toMatchObject({ success: false, refused: true })
    }
    expect(ask.approve).not.toHaveBeenCalled()
    expect(hits).toEqual([])
    expect(render.attempts).toBe(0)
  })

  it('refuses a redirect or a name into the local network, and does not render around it', async () => {
    const ask = policy(true)
    for (const path of ['/to-router', '/to-rebind']) {
      const page = await readPage(
        `http://public.test:${port}${path}`,
        undefined,
        network({ policy: ask })
      )
      expect(page, path).toMatchObject({ success: false, refused: true })
      expect(page.error, path).toMatch(/internet (?:into|lead into) the local network/)
    }
    const direct = await readPage(`http://rebind.test:${port}/admin`, undefined, network())
    expect(direct).toMatchObject({ success: false, refused: true })
    expect(hits).toEqual(['/to-router', '/to-rebind'])
    expect(ask.approve).not.toHaveBeenCalled()
    expect(render.attempts).toBe(0)
  })

  it('decodes a page by the charset its header or its meta tag names', async () => {
    const western = await readPage(`http://public.test:${port}/windows-1252`, undefined, network())
    expect(western.content).toContain('Café » menu')
    const japanese = await readPage(`http://public.test:${port}/shift-jis`, undefined, network())
    expect(japanese.content).toContain('日本')
  })

  it('still renders a public page that turned the direct request away', async () => {
    const page = await readPage(`http://public.test:${port}/forbidden`, undefined, network())
    expect(page).toMatchObject({ success: false })
    expect(page.refused).toBeUndefined()
    expect(render.attempts).toBe(1)
  })
})

describe('rendered page requests', () => {
  const network: WebNetworkOptions = {
    resolve: async (hostname) =>
      ({
        'cdn.example': [{ address: '93.184.216.34', family: 4 }],
        'rebind.example': [{ address: '192.168.1.1', family: 4 }],
        'self.example': [{ address: '127.0.0.1', family: 4 }]
      })[hostname] ?? []
  }

  it('lets a public page load from the internet, and nowhere else', async () => {
    for (const url of [
      'https://cdn.example/app.js',
      'http://cdn.example/style.css',
      'wss://cdn.example/socket',
      'https://8.8.8.8/x',
      'data:text/plain,hi',
      'blob:https://cdn.example/1234',
      'about:blank'
    ]) {
      expect(await renderRequestAllowed(url, undefined, network), url).toBe(true)
    }
    for (const url of [
      'http://192.168.1.1/',
      'https://192.168.1.1/',
      'http://printer.local/',
      'ws://10.0.0.1:8080/',
      'http://rebind.example/',
      'http://self.example/',
      'http://localhost:9333/json',
      'http://127.0.0.1/',
      'http://[::ffff:7f00:1]/',
      'http://[fe80::1]/',
      'http://user:pass@cdn.example/',
      'file:///etc/passwd',
      'chrome://settings',
      'not a url'
    ]) {
      expect(await renderRequestAllowed(url, undefined, network), url).toBe(false)
    }
  })

  it('lets an admitted device page load only from itself', async () => {
    const device = 'http://192.168.1.1'
    expect(await renderRequestAllowed('http://192.168.1.1/app.js', device, network)).toBe(true)
    expect(await renderRequestAllowed('ws://192.168.1.1/live', device, network)).toBe(true)
    expect(await renderRequestAllowed('http://192.168.1.2/', device, network)).toBe(false)
    expect(await renderRequestAllowed('http://192.168.1.1:8080/', device, network)).toBe(false)
    expect(await renderRequestAllowed('http://localhost/', device, network)).toBe(false)
    expect(await renderRequestAllowed('https://cdn.example/lib.js', device, network)).toBe(true)
  })

  it('catches a response from an address its request should not have reached', () => {
    expect(renderResponseAllowed('https://cdn.example/', '93.184.216.34', undefined)).toBe(true)
    expect(renderResponseAllowed('https://cdn.example/', undefined, undefined)).toBe(true)
    expect(renderResponseAllowed('http://rebind.example/', '192.168.1.1', undefined)).toBe(false)
    expect(renderResponseAllowed('http://rebind.example/', '::ffff:7f00:1', undefined)).toBe(false)
    expect(renderResponseAllowed('http://rebind.example/', '::1', 'http://rebind.example')).toBe(
      false
    )
    expect(renderResponseAllowed('http://192.168.1.1/x', '192.168.1.1', 'http://192.168.1.1')).toBe(
      true
    )
    expect(
      renderResponseAllowed('http://192.168.1.1:81/x', '192.168.1.1', 'http://192.168.1.1')
    ).toBe(false)
  })
})
