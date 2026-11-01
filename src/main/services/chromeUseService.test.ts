import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { request } from 'http'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { getAgentToolDefinitions } from '../../shared/agentToolCatalog'
import { ChromeBrowserRuntime } from './chromeBrowserRuntime'
import { ChromeUseBridge, chromeExtensionId } from './chromeUseBridge'
import { ChromeUseService, readsLikeALook } from './chromeUseService'
import { parseChromeProfiles } from './chromeUseSetup'

const signal = new AbortController().signal
const BUNDLED = resolve('resources/chrome-extension')

function harness(url = 'https://shop.example/page', answer = true, everySite = true) {
  const page = { url }
  const surface = { webContentsId: 7, getURL: () => page.url } as never
  const send = vi.fn(async (op: string, _args: Record<string, unknown>) =>
    op === 'activeTab' ? { id: 7, title: 'Shop', url: page.url } : null
  )
  const confirmSite = vi.fn(async () => answer)
  const confirmSharedTab = vi.fn(async () => answer)
  const confirmPress = vi.fn(async () => answer)
  const confirmScript = vi.fn(async () => answer)
  const disarm = vi.fn()
  const overlay = {
    show: vi.fn(),
    hide: vi.fn(),
    preview: vi.fn(),
    replyEnded: vi.fn(),
    armStop: vi.fn((_stop: () => void) => disarm),
    notify: vi.fn(),
    accent: async () => '#86aee8'
  }
  const service = new ChromeUseService({
    bridge: {
      send: send as never,
      isConnected: () => true,
      waitForConnection: async () => true
    },
    bringUpChrome: async () => true,
    overlay,
    setTimer: (() => 0) as never,
    askEverySite: () => everySite,
    confirmSite,
    confirmSharedTab,
    confirmPress,
    confirmScript,
    confirmDownload: async () => answer,
    confirmUpload: async () => answer
  })
  const inChat = <T>(work: () => Promise<T>): Promise<T> => service.runInChat('chat', work)
  return {
    service,
    inChat,
    surface,
    send,
    page,
    overlay,
    disarm,
    confirmSite,
    confirmSharedTab,
    confirmPress,
    confirmScript
  }
}

const sent = (send: ReturnType<typeof harness>['send'], op: string): boolean =>
  send.mock.calls.some(([name]) => name === op)

describe('what the agent may reach in Chrome', () => {
  it('asks about a site once a chat, and takes no for an answer', async () => {
    const allowed = harness()
    await allowed.inChat(() => allowed.service.beforeNavigate('https://shop.example/a', signal))
    await allowed.inChat(() => allowed.service.beforeNavigate('https://shop.example/b', signal))
    expect(allowed.confirmSite).toHaveBeenCalledTimes(1)
    const refused = harness('https://shop.example/', false)
    await expect(
      refused.inChat(() => refused.service.beforeNavigate('https://shop.example/', signal))
    ).rejects.toThrow('did not allow')
  })

  it.each([
    'chrome://settings/passwords',
    'chrome-extension://abc/page.html',
    'file:///C:/x',
    'javascript:alert(1)'
  ])('never opens %s', async (url) => {
    const { service, inChat } = harness()
    await expect(inChat(() => service.beforeNavigate(url, signal))).rejects.toThrow(
      'Only web pages'
    )
  })

  it('asks about no ordinary site unless the user chose that, but always about sensitive ones', async () => {
    const { service, inChat, surface, page, confirmSite } = harness(
      'https://shop.example/',
      false,
      false
    )
    await inChat(() => service.beforeNavigate('https://shop.example/', signal))
    expect(confirmSite).not.toHaveBeenCalled()
    await expect(
      inChat(() => service.beforeNavigate('https://mail.google.com/', signal))
    ).rejects.toThrow('did not allow')
    expect(confirmSite).toHaveBeenCalledWith('https://mail.google.com', true, signal)
    // A click or a page can get there by itself, and no step happens on it until the user says.
    page.url = 'https://www.mybank.example/account'
    await expect(inChat(() => service.beforeStep(surface, signal))).rejects.toThrow('did not allow')
  })

  it('never opens a web vault of saved passwords, even if the user would allow it', async () => {
    const { service, inChat, confirmSite } = harness()
    await expect(
      inChat(() => service.beforeNavigate('https://passwords.google.com/', signal))
    ).rejects.toThrow('saved passwords')
    expect(confirmSite).not.toHaveBeenCalled()
  })

  it('takes no step for anything but a chat, whose answers it can tell apart', async () => {
    const { service, surface } = harness()
    await expect(service.beforeStep(surface, signal)).rejects.toThrow('did not come from a chat')
    await expect(service.beforeNavigate('https://shop.example/', signal)).rejects.toThrow(
      'did not come from a chat'
    )
  })

  it('stays somewhere the agent can leave when an address fails, without asking about it', async () => {
    const { service, inChat, surface, page, confirmSite } = harness()
    page.url = 'chrome-error://chromewebdata/'
    await inChat(() => service.beforeStep(surface, signal))
    expect(confirmSite).not.toHaveBeenCalled()
  })

  it('shows the model nothing of the tab the user is on until they share it', async () => {
    const { service, inChat, confirmSharedTab } = harness('https://bank.example/', false)
    await expect(inChat(() => service.shareMyTab(signal))).rejects.toThrow('did not share')
    expect(confirmSharedTab).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://bank.example/' }),
      signal
    )
  })

  it('refuses a password or payment field', () => {
    const { service } = harness()
    expect(() => service.beforeTyping({ secret: true })).toThrow('password or payment')
    expect(() => service.beforeTyping({ secret: false })).not.toThrow()
  })

  it('asks the user, not the model, before a press that may not be reversible', async () => {
    const { service, confirmPress } = harness('https://shop.example/', false)
    await expect(service.beforePress('Buy now', 'https://shop.example/', signal)).rejects.toThrow(
      'did not allow'
    )
    await service.beforePress('Details', 'https://shop.example/', signal)
    expect(confirmPress).toHaveBeenCalledTimes(1)
  })

  it('shows the user every script, since one can read all a signed-in page holds', async () => {
    const { service, confirmScript } = harness()
    await service.beforeEvaluate('document.cookie', 'https://shop.example/', signal)
    await service.beforeEvaluate('document.cookie', 'https://shop.example/', signal)
    expect(confirmScript).toHaveBeenCalledTimes(2)
    confirmScript.mockResolvedValue(false)
    await expect(
      service.beforeEvaluate('document.cookie', 'https://shop.example/', signal)
    ).rejects.toThrow('did not allow')
  })
})

describe('scripts that only look', () => {
  it.each([
    'document.title',
    "[...document.querySelectorAll('a[href]')].map((a) => a.href)",
    "(() => { const a = document.querySelector('a'); return { href: a?.getAttribute('href') } })()",
    'document.links[0].href',
    "document.body['innerText'].length"
  ])('leaves %s to the browser’s own check', (script) => {
    expect(readsLikeALook(script)).toBe(true)
  })

  it.each([
    'document.cookie',
    "document['cookie']",
    "const k = 'coo' + 'kie'; document[k]",
    'document[`coo${"kie"}`]',
    "const { ['coo' + 'kie']: c } = document; c",
    'doc\\u0075ment.title',
    "localStorage.getItem('token')",
    "Reflect.get(document, 'x')",
    "Object.getOwnPropertyDescriptor(Document.prototype, 'x')",
    "eval('1')",
    "[].constructor.constructor('return 1')()",
    'await 1'
  ])('asks about %s', (script) => {
    expect(readsLikeALook(script)).toBe(false)
  })
})

describe('when it is driving', () => {
  it('stops for good on Esc: the reply gets nowhere, and its approvals are gone', async () => {
    const { service, inChat, surface, send, overlay, disarm, confirmSite } = harness()
    await inChat(() => service.beforeStep(surface, signal))
    expect(overlay.armStop).toHaveBeenCalledTimes(1)
    overlay.armStop.mock.calls[0][0]()
    expect(disarm).toHaveBeenCalled()
    expect(overlay.hide).toHaveBeenCalled()
    expect(sent(send, 'detachAll')).toBe(true)
    await expect(inChat(() => service.beforeStep(surface, signal))).rejects.toThrow('pressed Esc')
    await expect(
      inChat(() => service.beforeNavigate('https://shop.example/', signal))
    ).rejects.toThrow('pressed Esc')
    await expect(inChat(() => service.ready(signal))).rejects.toThrow('pressed Esc')
    service.runEnded('chat')
    await inChat(() => service.beforeStep(surface, signal))
    expect(confirmSite).toHaveBeenCalledTimes(2)
  })

  it('takes the marks off when the reply ends, keeping what the user allowed', async () => {
    const { service, inChat, surface, send, overlay, disarm, confirmSite } = harness()
    await inChat(() => service.beforeStep(surface, signal))
    service.runEnded('chat')
    expect(disarm).toHaveBeenCalled()
    expect(overlay.hide).toHaveBeenCalled()
    expect(sent(send, 'overlaysOff')).toBe(true)
    await inChat(() => service.beforeStep(surface, signal))
    expect(confirmSite).toHaveBeenCalledTimes(1)
  })
})

describe('the browser tools in Chrome', () => {
  it('offers Chrome only where the user turned it on, with no second set of tools', () => {
    const names = (chromeEnabled: boolean) =>
      getAgentToolDefinitions({
        surface: 'conversation',
        browserEnabled: true,
        chromeEnabled
      } as never).map((tool) => tool.function.name)
    expect(names(false)).not.toContain('browser_use_my_tab')
    expect(names(true)).toContain('browser_use_my_tab')
    expect(names(true)).not.toContain('chrome')
  })

  it('takes its picture without laying the user’s page out again', async () => {
    const send = vi.fn(async (op: string, args: Record<string, unknown>) => {
      if (op === 'open') return { id: 7, title: '', url: 'about:blank', windowId: 1 }
      return args.method === 'Page.getLayoutMetrics'
        ? { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }
        : { data: 'cGlj' }
    })
    const fitPicture = vi.fn((picture: Buffer) => picture)
    const runtime = new ChromeBrowserRuntime(
      { send: send as never, onEvent: () => () => undefined },
      { showPointer: () => undefined, fitPicture }
    )
    const surface = await runtime.createSurface()
    expect(await surface.captureViewport()).toMatchObject({ width: 800, height: 600 })
    const shot = send.mock.calls.find(([, args]) => args.method === 'Page.captureScreenshot')
    expect(shot?.[1].params).not.toHaveProperty('clip')
    expect(fitPicture).toHaveBeenCalledWith(expect.any(Buffer), 800, 600)
  })
})

describe('the line to the extension', () => {
  const manifest = JSON.parse(readFileSync(join(BUNDLED, 'manifest.json'), 'utf8')) as {
    key: string
    version: string
  }
  const origin = `chrome-extension://${chromeExtensionId(manifest.key)}`

  async function line() {
    const folder = mkdtempSync(join(tmpdir(), 'sk-chrome-'))
    const bridge = new ChromeUseBridge(
      () => BUNDLED,
      () => folder
    )
    await bridge.start()
    const { port, token } = JSON.parse(readFileSync(join(folder, 'pairing.json'), 'utf8')) as {
      port: number
      token: string
    }
    const call = (headers: Record<string, string>, path = '/answer'): Promise<number> =>
      new Promise((done, fail) => {
        const sent = request(
          { host: '127.0.0.1', port, path, method: 'POST', headers },
          (response) => {
            response.resume()
            done(response.statusCode ?? 0)
          }
        )
        sent.on('error', fail)
        sent.end('{}')
      })
    return { bridge, call, token, port }
  }

  it('only answers the extension: right origin, right secret, and its own address', async () => {
    const { bridge, call, token, port } = await line()
    const bearer = `Bearer ${token}`
    expect(await call({ authorization: bearer, origin })).toBe(204)
    expect(await call({ authorization: bearer, origin: 'https://evil.example' })).toBe(403)
    expect(await call({ authorization: bearer })).toBe(403)
    expect(await call({ authorization: 'Bearer wrong', origin })).toBe(403)
    expect(await call({ origin })).toBe(403)
    // A page that points its own name at this address.
    expect(await call({ authorization: bearer, origin, host: 'evil.example' })).toBe(403)
    expect(await call({ authorization: bearer, origin, host: `127.0.0.1:${port}` })).toBe(204)
    await bridge.close()
  })

  it('only takes a new worker as proof that setup loaded the extension', async () => {
    const { bridge, token, port } = await line()
    const ask = (instance: string): void => {
      request({
        host: '127.0.0.1',
        port,
        path: '/next',
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          origin,
          'x-sidekick-instance': instance,
          'x-sidekick-version': manifest.version
        }
      })
        .on('error', () => undefined)
        .end()
    }
    ask('old')
    await vi.waitFor(() => expect(bridge.latestWorker()).toBe('old'))
    expect(await bridge.waitForNewWorker('old', 50, signal)).toBe(false)
    ask('new')
    expect(await bridge.waitForNewWorker('old', 2000, signal)).toBe(true)
    await bridge.close()
  })

  it('tells Chrome to load new files once, and only when they changed', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'sk-chrome-'))
    const start = async () => {
      const bridge = new ChromeUseBridge(
        () => BUNDLED,
        () => folder
      )
      await bridge.start()
      const { port, token } = JSON.parse(readFileSync(join(folder, 'pairing.json'), 'utf8')) as {
        port: number
        token: string
      }
      return { bridge, port, token }
    }
    const firstWork = (port: number, token: string, instance: string): Promise<string> =>
      new Promise((done, fail) => {
        request(
          {
            host: '127.0.0.1',
            port,
            path: '/next',
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              origin,
              'x-sidekick-instance': instance,
              'x-sidekick-version': '1'
            }
          },
          (response) => {
            let body = ''
            response.on('data', (chunk) => (body += chunk))
            response.on('end', () => done(body))
          }
        )
          .on('error', fail)
          .end()
      })
    // A first install has nothing older to replace.
    const first = await start()
    expect(existsSync(join(folder, 'reload-needed'))).toBe(false)
    await first.bridge.close()
    // The same files again change nothing.
    const same = await start()
    expect(existsSync(join(folder, 'reload-needed'))).toBe(false)
    await same.bridge.close()
    // As after an update of SideKick: what Chrome has is older than what ships.
    writeFileSync(join(folder, 'background.js'), '// older')
    const updated = await start()
    expect(readFileSync(join(folder, 'background.js'), 'utf8')).not.toContain('// older')
    const answer = firstWork(updated.port, updated.token, 'old worker')
    await vi.waitFor(() => expect(existsSync(join(folder, 'reload-needed'))).toBe(false))
    expect(await answer).toContain('"op":"reload"')
    // The worker it restarted asks next, and isn't told again.
    const next = firstWork(updated.port, updated.token, 'new worker')
    await new Promise((resolve) => setTimeout(resolve, 100))
    await updated.bridge.close()
    expect(await next).not.toContain('reload')
  })

  it('stops counting a disconnected worker at once, and gives it nothing but its removal', async () => {
    const { bridge, token, port } = await line()
    const headers = {
      authorization: `Bearer ${token}`,
      origin,
      'x-sidekick-instance': 'only',
      'x-sidekick-version': manifest.version
    }
    const ask = (): Promise<{ status: number; body: string }> =>
      new Promise((done, fail) => {
        request({ host: '127.0.0.1', port, path: '/next', method: 'POST', headers }, (response) => {
          let body = ''
          response.on('data', (chunk) => (body += chunk))
          response.on('end', () => done({ status: response.statusCode ?? 0, body }))
        })
          .on('error', fail)
          .end()
      })
    const held = ask()
    await vi.waitFor(() => expect(bridge.isConnected()).toBe(true))
    expect(bridge.retire()).toBe(true)
    expect(bridge.isConnected()).toBe(false)
    expect((await held).body).toContain('uninstallSelf')
    expect((await ask()).status).toBe(403)
    expect(bridge.isConnected()).toBe(false)
    expect(bridge.retire()).toBe(false)
    await bridge.close()
  })

  it('counts nobody as connected until the extension has asked for work', async () => {
    const { bridge } = await line()
    expect(bridge.isConnected()).toBe(false)
    await bridge.close()
  })
})

describe('the extension itself', () => {
  const source = readFileSync(join(BUNDLED, 'background.js'), 'utf8')

  it('passes on only what the browser tools use: no cookies, storage, or other tabs', () => {
    const allowed = /const ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? ''
    expect(allowed).toContain('Input.dispatchMouseEvent')
    expect(allowed).not.toMatch(/cookie|'Storage\.|'Target\.|'Browser\.|'SystemInfo\.|'Debugger\./i)
    expect(source).toContain('if (!ALLOWED_COMMANDS.has(method))')
    const manifest = JSON.parse(readFileSync(join(BUNDLED, 'manifest.json'), 'utf8')) as {
      permissions: string[]
    }
    expect(manifest.permissions).not.toContain('cookies')
    expect(manifest.permissions).not.toContain('nativeMessaging')
  })
})

describe('Chrome profiles', () => {
  it('tells a work profile from a personal one', () => {
    expect(
      parseChromeProfiles(
        JSON.stringify({
          profile: {
            info_cache: {
              Default: {
                name: 'Me',
                hosted_domain: 'NO_HOSTED_DOMAIN',
                gaia_picture_file_name: 'Google Profile Picture.png',
                default_avatar_fill_color: -13559530
              },
              'Profile 1': {
                name: 'Work',
                hosted_domain: 'company.example',
                // Only ever read from inside the profile's own folder.
                gaia_picture_file_name: '..\\..\\secret.png'
              }
            }
          }
        })
      )
    ).toEqual([
      {
        directory: 'Default',
        name: 'Me',
        managed: false,
        pictureFile: 'Google Profile Picture.png',
        color: '#31191 6'.replace(' ', '')
      },
      { directory: 'Profile 1', name: 'Work', managed: true, domain: 'company.example' }
    ])
  })
})
