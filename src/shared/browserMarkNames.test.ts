import { describe, expect, it } from 'vitest'
import { browserMarkKind, browserMarkName } from './browserMarkNames'

describe('browser mark names', () => {
  it('names a mark in plain words from its role, else its tag', () => {
    expect(browserMarkKind('heading', 'h2')).toBe('Heading')
    expect(browserMarkKind(undefined, 'IMG')).toBe('Image')
    expect(browserMarkKind(undefined, 'div')).toBe('Block')
    expect(browserMarkKind()).toBe('Element')
  })

  it('adds what the element says, shortened', () => {
    expect(browserMarkName({ role: 'link', tag: 'a', accessibleName: 'World  news' })).toBe(
      'Link “World news”'
    )
    expect(
      browserMarkName({
        tag: 'p',
        text: 'Almost 1,000 arrested as clashes follow another day of mass protests across France'
      })
    ).toBe('Text “Almost 1,000 arrested as clashes follow another…”')
    expect(browserMarkName({ tag: 'img' })).toBe('Image')
  })
})
