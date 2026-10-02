import { describe, expect, it } from 'vitest'
import { extensionOf, highlightLines, languageFor, parseNumberedLines } from './codeHighlight'

describe('parseNumberedLines', () => {
  it('splits read tool lines into numbers and source text', () => {
    expect(parseNumberedLines('9: <ul>\n10:   <li>One</li>\n')).toEqual([
      { number: 9, text: '<ul>' },
      { number: 10, text: '  <li>One</li>' }
    ])
  })

  it('keeps a saved page that starts and ends mid-line', () => {
    expect(parseNumberedLines('ing</li>\n272: </ul>\n273: <h3>Crime</h3>\n274: <ul cla')).toEqual([
      { number: null, text: 'ing</li>' },
      { number: 272, text: '</ul>' },
      { number: 273, text: '<h3>Crime</h3>' },
      { number: 274, text: '<ul cla' }
    ])
  })

  it('leaves other output alone', () => {
    expect(parseNumberedLines('lines=410 bytes=41764\nhtmlClose=1')).toBeNull()
    expect(parseNumberedLines('Step 1: build\nnot numbered\n3: deploy')).toBeNull()
    expect(parseNumberedLines('just one line')).toBeNull()
  })
})

describe('highlighting', () => {
  it('names languages by file extension', () => {
    expect(extensionOf('site/index.html')).toBe('html')
    expect(languageFor('tsx')).toBe('typescript')
    expect(languageFor('nope')).toBeNull()
  })

  it('returns escaped HTML for each source line', () => {
    const lines = highlightLines('<b>\n</b>', 'html')
    expect(lines).toHaveLength(2)
    expect(lines.join('')).not.toContain('<b>')
  })
})
