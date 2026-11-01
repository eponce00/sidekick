import { describe, expect, it } from 'vitest'
import { BROWSER_SEARCH_URL, browserAddress } from './browserAddress'

const search = (words: string): string => `${BROWSER_SEARCH_URL}${encodeURIComponent(words)}`

describe('browserAddress', () => {
  it('opens addresses as typed and host names as web pages', () => {
    expect(browserAddress('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(browserAddress('example.com')).toBe('https://example.com')
    expect(browserAddress('  docs.github.io/pages  ')).toBe('https://docs.github.io/pages')
    expect(browserAddress('file:///C:/notes/a.html')).toBe('file:///C:/notes/a.html')
  })

  it('opens this computer and the local network over plain HTTP', () => {
    expect(browserAddress('localhost:5173')).toBe('http://localhost:5173')
    expect(browserAddress('192.168.1.20:8080/app')).toBe('http://192.168.1.20:8080/app')
    expect(browserAddress('[::1]:3000')).toBe('http://[::1]:3000')
  })

  it('searches for anything that is not a page', () => {
    expect(browserAddress('weather tomorrow')).toBe(search('weather tomorrow'))
    expect(browserAddress('sidekick')).toBe(search('sidekick'))
    expect(browserAddress('what is 2+2?')).toBe(search('what is 2+2?'))
    // A dot alone does not make a host name.
    expect(browserAddress('v1.2')).toBe(search('v1.2'))
    expect(browserAddress('')).toBe('')
  })
})
