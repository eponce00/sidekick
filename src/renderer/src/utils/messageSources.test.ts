import { describe, expect, it } from 'vitest'
import { extractMessageSources } from './messageSources'

describe('extractMessageSources', () => {
  it('collects markdown links and bare urls once per host, in order', () => {
    const sources = extractMessageSources(
      'See [the agenda](https://www.fest.fr/agenda?x=1) and https://allevents.in/rennes. ' +
        'Also https://fest.fr/other and (https://rennes.info/what).'
    )
    expect(sources.map((s) => s.host)).toEqual(['fest.fr', 'allevents.in', 'rennes.info'])
    expect(sources[0]).toMatchObject({ label: 'the agenda', url: 'https://www.fest.fr/agenda?x=1' })
    expect(sources[1].label).toBeUndefined()
  })

  it('ignores links inside code and non-http schemes', () => {
    const sources = extractMessageSources(
      'Run `curl https://example.com/api` then see ```\nhttps://ignored.dev\n``` and mailto:a@b.c'
    )
    expect(sources).toEqual([])
  })

  it('drops trailing punctuation that is not part of the url', () => {
    expect(extractMessageSources('Docs: https://docs.example.com/page.')[0].url).toBe(
      'https://docs.example.com/page'
    )
  })

  it('does not use a bare url as its own label', () => {
    const [source] = extractMessageSources('[https://x.io](https://x.io)')
    expect(source.label).toBeUndefined()
  })
})
