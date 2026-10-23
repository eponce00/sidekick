import { describe, expect, it } from 'vitest'
import { entryState, HOME, readEntry, splitLayers } from './navigation'

describe('history entries', () => {
  it('read back what they wrote', () => {
    const entry = { nav: 3, chat: { id: 'chat-a', title: 'Fix the build' }, layer: 1 }
    expect(readEntry(entryState(entry))).toEqual(entry)
    expect(readEntry(entryState({ nav: 0, chat: HOME, layer: 0 }))).toEqual({
      nav: 0,
      chat: { id: null, title: '' },
      layer: 0
    })
  })

  it('ignore states another page or an older version wrote', () => {
    expect(readEntry(null)).toBeNull()
    expect(readEntry({ sidekickCompanionChat: 'chat-a' })).toBeNull()
    expect(readEntry({ sidekickPhone: { nav: '1', chat: HOME, layer: 0 } })).toBeNull()
  })
})

describe('splitLayers', () => {
  const drawer = { depth: 1, name: 'drawer' }
  const sheet = { depth: 2, name: 'sheet' }

  it('closes what is above the entry back landed on, topmost first', () => {
    expect(splitLayers([drawer, sheet], 1)).toEqual({ kept: [drawer], closed: [sheet] })
    expect(splitLayers([drawer, sheet], 0)).toEqual({ kept: [], closed: [sheet, drawer] })
  })

  it('keeps everything when history moved to the same depth or deeper', () => {
    expect(splitLayers([drawer], 1)).toEqual({ kept: [drawer], closed: [] })
    expect(splitLayers([drawer], 2)).toEqual({ kept: [drawer], closed: [] })
  })
})
