import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SiteIconService } from './siteIconService'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function response(status: number, body: Uint8Array | string, type: string): Response {
  return new Response(body as BodyInit, { status, headers: { 'content-type': type } })
}

describe('SiteIconService', () => {
  let cacheDir: string
  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'sidekick-icons-'))
  })
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('uses /favicon.ico from the site itself and caches the result', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://example.com/favicon.ico')
      return response(200, PNG, 'image/png')
    })
    const service = new SiteIconService(cacheDir, fetchImpl as unknown as typeof fetch)

    const first = await service.iconFor('https://example.com/some/page?x=1')
    expect(first).toMatch(/^data:image\/png;base64,/)

    // Second service instance: only the disk cache is shared, so a hit means
    // the site was not contacted again.
    const again = new SiteIconService(cacheDir, fetchImpl as unknown as typeof fetch)
    expect(await again.iconFor('https://example.com/other')).toBe(first)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('falls back to the icon declared in the page head', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = String(url)
      if (value.endsWith('/favicon.ico')) return response(404, '', 'text/html')
      if (value === 'https://example.org/')
        return response(
          200,
          '<html><head><link rel="shortcut icon" href="/static/i.png"></head><body></body></html>',
          'text/html'
        )
      if (value === 'https://example.org/static/i.png') return response(200, PNG, 'image/png')
      throw new Error(`unexpected ${value}`)
    })
    const service = new SiteIconService(cacheDir, fetchImpl as unknown as typeof fetch)
    expect(await service.iconFor('https://example.org/deep/link')).toMatch(/^data:image\/png/)
  })

  it('never contacts anything for non-http or local hosts', async () => {
    const fetchImpl = vi.fn()
    const service = new SiteIconService(cacheDir, fetchImpl as unknown as typeof fetch)
    expect(await service.iconFor('mailto:a@b.c')).toBeNull()
    expect(await service.iconFor('http://localhost:5173/x')).toBeNull()
    expect(await service.iconFor('http://192.168.1.4/')).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects non-image responses and remembers the miss', async () => {
    const fetchImpl = vi.fn(async () => response(200, '<html>not an icon</html>', 'text/html'))
    const service = new SiteIconService(cacheDir, fetchImpl as unknown as typeof fetch)
    expect(await service.iconFor('https://nothing.test/')).toBeNull()
    const again = new SiteIconService(cacheDir, fetchImpl as unknown as typeof fetch)
    expect(await again.iconFor('https://nothing.test/')).toBeNull()
    // ico + html-fallback root fetch on the first pass only.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('reads the first icon link in the head only', () => {
    expect(
      SiteIconService.declaredIconHref(
        '<head><link rel="stylesheet" href="a.css"><link rel="icon" type="image/png" href="/b.png"><link rel="apple-touch-icon" href="/c.png"></head>'
      )
    ).toBe('/b.png')
    expect(
      SiteIconService.declaredIconHref('<head></head><body><link rel="icon" href="/x"></body>')
    ).toBeNull()
  })
})
