import { mkdtempSync, readFileSync } from 'fs'
import { request } from 'http'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { ChromeUseBridge, chromeExtensionId } from './chromeUseBridge'
import { ChromeUseService } from './chromeUseService'
import { parseChromeProfiles } from './chromeUseSetup'

const signal = new AbortController().signal
const BUNDLED = resolve('resources/chrome-extension')

function harness(url = 'https://shop.example/page', answer = true) {
  const page = { url }
  const located = { x: 1, y: 2, name: 'Details', submit: '', secret: false }
  const send = vi.fn(async (op: string, _args: Record<string, unknown>) => {
    if (op === 'tabInfo' || op === 'open' || op === 'activeTab') {
      return { id: 7, title: 'Shop', url: page.url, active: true, windowId: 3 }
    }
    if (op === 'locate') return located
    if (op === 'focused') return { name: '', submit: located.submit, secret: located.secret }
    if (op === 'read') return { title: 'Shop', url: page.url, rows: [], total: 0, text: 'hi' }
    return null
  })
  const confirmSite = vi.fn(async () => answer)
  const confirmSharedTab = vi.fn(async () => answer)
  const confirmPress = vi.fn(async () => answer)
  const service = new ChromeUseService({
    bridge: {
      send: send as never,
      isConnected: () => true,
      waitForConnection: async () => true
    },
    bringUpChrome: async () => true,
    confirmSite,
    confirmSharedTab,
    confirmPress
  })
  return { service, send, page, located, confirmSite, confirmSharedTab, confirmPress }
}

const sent = (send: ReturnType<typeof harness>['send'], op: string): boolean =>
  send.mock.calls.some(([name]) => name === op)

describe('what the agent may reach in Chrome', () => {
  it('asks about a site once a chat, and takes no for an answer', async () => {
    const allowed = harness()
    await allowed.service.open('chat', 'https://shop.example/a', signal)
    await allowed.service.open('chat', 'https://shop.example/b', signal)
    expect(allowed.confirmSite).toHaveBeenCalledTimes(1)
    const refused = harness('https://shop.example/', false)
    await expect(refused.service.open('chat', 'https://shop.example/', signal)).rejects.toThrow(
      'did not allow'
    )
    expect(sent(refused.send, 'open')).toBe(false)
  })

  it.each([
    'chrome://settings/passwords',
    'chrome-extension://abc/page.html',
    'file:///C:/x',
    'javascript:alert(1)'
  ])('never opens %s', async (url) => {
    const { service, send } = harness()
    await expect(service.open('chat', url, signal)).rejects.toThrow('Only web pages')
    expect(sent(send, 'open')).toBe(false)
  })

  it('never opens a web vault of saved passwords, even if the user would allow it', async () => {
    const { service, send, confirmSite } = harness()
    await expect(service.open('chat', 'https://passwords.google.com/', signal)).rejects.toThrow(
      'saved passwords'
    )
    expect(confirmSite).not.toHaveBeenCalled()
    expect(sent(send, 'open')).toBe(false)
  })

  it("won't touch a tab that isn't the chat's", async () => {
    const { service, send } = harness()
    await service.open('mine', 'https://shop.example/', signal)
    await expect(service.read('other', signal, 7)).rejects.toThrow("isn't one of this chat's")
    await expect(service.read('mine', signal, 99)).rejects.toThrow("isn't one of this chat's")
    expect(sent(send, 'read')).toBe(false)
  })

  it('shows the model nothing of the tab the user is on until they share it', async () => {
    const { service, send, confirmSharedTab } = harness('https://bank.example/', false)
    await expect(service.useMyTab('chat', signal)).rejects.toThrow('did not share')
    expect(confirmSharedTab).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://bank.example/' }),
      signal
    )
    expect(sent(send, 'read')).toBe(false)
    await expect(service.read('chat', signal)).rejects.toThrow('Open a page first')
  })

  it('asks again when a tab has gone to a site that was not allowed', async () => {
    const { service, page, confirmSite, send } = harness()
    await service.open('chat', 'https://shop.example/', signal)
    page.url = 'https://elsewhere.example/'
    confirmSite.mockResolvedValue(false)
    await expect(service.read('chat', signal)).rejects.toThrow('did not allow')
    expect(sent(send, 'read')).toBe(false)
  })

  it('refuses a password or payment field, by typing or by keys', async () => {
    const { service, send, located } = harness()
    await service.open('chat', 'https://shop.example/', signal)
    located.secret = true
    await expect(service.type('chat', 1, 'hunter2', signal)).rejects.toThrow('password or payment')
    await expect(service.key('chat', 'h', [], signal)).rejects.toThrow('password or payment')
    expect(sent(send, 'typeText')).toBe(false)
    expect(sent(send, 'pressKey')).toBe(false)
  })

  it('asks the user, not the model, before a press that may not be reversible', async () => {
    const { service, send, located, confirmPress } = harness()
    await service.open('chat', 'https://shop.example/', signal)
    located.name = 'Buy now'
    confirmPress.mockResolvedValue(false)
    await expect(service.click('chat', 1, signal)).rejects.toThrow('did not allow')
    expect(sent(send, 'click')).toBe(false)
    confirmPress.mockResolvedValue(true)
    await service.click('chat', 1, signal)
    expect(sent(send, 'click')).toBe(true)
  })

  it('treats Enter as pressing the button of the form it is in', async () => {
    const { service, send, located, confirmPress } = harness()
    await service.open('chat', 'https://shop.example/', signal)
    located.submit = 'Place order'
    confirmPress.mockResolvedValue(false)
    await expect(service.key('chat', 'return', [], signal)).rejects.toThrow('did not allow')
    expect(sent(send, 'pressKey')).toBe(false)
  })
})

describe('the line to the extension', () => {
  const manifest = JSON.parse(readFileSync(join(BUNDLED, 'manifest.json'), 'utf8')) as {
    key: string
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

  it('counts nobody as connected until the extension has asked for work', async () => {
    const { bridge } = await line()
    expect(bridge.isConnected()).toBe(false)
    await bridge.close()
  })
})

describe('the extension itself', () => {
  const source = readFileSync(join(BUNDLED, 'background.js'), 'utf8')

  it('offers no way to run a script of the model’s or read cookies', () => {
    const operations = /const OPERATIONS = \{[\s\S]*?\n\}/.exec(source)?.[0] ?? ''
    expect(operations).not.toMatch(/evaluate|eval|cookie|debugger/i)
    expect(source).not.toMatch(/Runtime\.evaluate|Network\.getCookies|Storage\.getCookies/)
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
