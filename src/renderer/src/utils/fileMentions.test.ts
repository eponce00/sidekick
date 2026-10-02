import { describe, expect, it } from 'vitest'
import { activeFileMentionAtCursor, insertFileMention, rankFileMentions } from './fileMentions'

describe('file mentions', () => {
  it('finds the mention being typed at the caret, and only at a word start', () => {
    expect(activeFileMentionAtCursor('clean up @site/ind', 18)).toEqual({
      start: 9,
      query: 'site/ind'
    })
    expect(activeFileMentionAtCursor('@', 1)).toEqual({ start: 0, query: '' })
    expect(activeFileMentionAtCursor('mail me@example.com', 19)).toBeNull()
    expect(activeFileMentionAtCursor('@site/index.html then', 21)).toBeNull()
  })

  it('ranks file names over folders, and nearer files first', () => {
    const files = [
      'docs/',
      'web/src/index.css',
      'site/index.html',
      'index.html',
      'web/src/components/IndexCard.tsx',
      'notes/inbox.md'
    ]
    expect(rankFileMentions(files, 'index')).toEqual([
      'index.html',
      'site/index.html',
      'web/src/index.css',
      'web/src/components/IndexCard.tsx'
    ])
    // Letters in order still match, after every closer match.
    expect(rankFileMentions(files, 'sih')).toEqual(['site/index.html'])
    expect(rankFileMentions(files, '')).not.toContain('docs/')
  })

  it('replaces the typed mention with the chosen path', () => {
    const value = 'clean up @site/ind and keep it short'
    const mention = activeFileMentionAtCursor(value, 18)!
    expect(insertFileMention(value, mention, 18, 'site/index.html')).toEqual({
      value: 'clean up @site/index.html and keep it short',
      caret: 26
    })
  })
})
