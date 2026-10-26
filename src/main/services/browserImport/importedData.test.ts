import { describe, expect, it } from 'vitest'
import { BROWSER_IMPORT_LIMITS } from '../../../shared/browserLibrary'
import { BookmarkCollector, collectPages, importableUrl, importedTitle } from './importedData'

describe('importableUrl', () => {
  it('keeps web pages, normalized', () => {
    expect(importableUrl(' https://Example.com ')).toBe('https://example.com/')
    expect(importableUrl('http://localhost:3000/app')).toBe('http://localhost:3000/app')
  })

  it.each([
    'javascript:alert(document.cookie)',
    'JaVaScRiPt:void(0)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/System32/drivers/etc/hosts',
    'chrome://settings/passwords',
    'edge://wallet',
    'about:blank',
    'place:parent=menu________',
    'ftp://example.com/',
    'not a url',
    '',
    42,
    null,
    { url: 'https://example.com' }
  ])('refuses %j', (value) => {
    expect(importableUrl(value)).toBeUndefined()
  })

  it('refuses an address that carries a username or password', () => {
    expect(importableUrl('https://admin:hunter2@router.example/')).toBeUndefined()
    expect(importableUrl('https://token@api.example/')).toBeUndefined()
  })

  it('refuses an address longer than the limit, before or after normalizing', () => {
    expect(
      importableUrl(`https://example.com/${'a'.repeat(BROWSER_IMPORT_LIMITS.urlLength)}`)
    ).toBeUndefined()
    // Normalizing percent-encodes spaces, which can push a URL over the limit.
    const spaces = `https://example.com/${' '.repeat(BROWSER_IMPORT_LIMITS.urlLength - 40)}x`
    expect(importableUrl(spaces)).toBeUndefined()
  })
})

describe('importedTitle', () => {
  it('removes control and direction-override characters and keeps one line', () => {
    expect(importedTitle('Bank\u202Egnp.exe\nsecond\tline\u0000')).toBe('Bank gnp.exe second line')
  })

  it('cuts long titles and ignores values that are not text', () => {
    expect(importedTitle('x'.repeat(5000))).toHaveLength(BROWSER_IMPORT_LIMITS.titleLength)
    expect(importedTitle(undefined)).toBe('')
    expect(importedTitle({ toString: () => 'evil' })).toBe('')
  })
})

describe('BookmarkCollector', () => {
  it('stops at the limit and falls back to the address for a missing title', () => {
    const collector = new BookmarkCollector()
    for (let index = 0; index < BROWSER_IMPORT_LIMITS.bookmarks + 10; index++)
      collector.add(['Bar'], index ? `B${index}` : '', `https://example.com/${index}`)
    expect(collector.bookmarks).toHaveLength(BROWSER_IMPORT_LIMITS.bookmarks)
    expect(collector.bookmarks[0].title).toBe('https://example.com/0')
  })
})

describe('collectPages', () => {
  it('keeps the first of each address and drops what is not a web page', () => {
    const pages = collectPages([
      { url: 'https://a.example/', title: 'A', visits: 9, lastVisitAt: 1 },
      { url: 'https://a.example', title: 'A again', visits: 2, lastVisitAt: 2 },
      { url: 'javascript:1', title: 'x', visits: 99, lastVisitAt: 3 },
      { url: 'https://b.example/', title: 7, visits: -5, lastVisitAt: null }
    ])
    expect(pages).toEqual([
      { url: 'https://a.example/', title: 'A', visitCount: 9, lastVisitAt: 1 },
      { url: 'https://b.example/', title: '', visitCount: 0, lastVisitAt: null }
    ])
  })
})
