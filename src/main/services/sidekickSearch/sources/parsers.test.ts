import { describe, expect, it } from 'vitest'
import { parseBingResults } from './bing'
import { parseBraveResults } from './brave'
import { parseDuckDuckGoResults } from './duckDuckGo'

describe('embedded search source parsers', () => {
  it('parses DuckDuckGo result pages and unwraps destination URLs', () => {
    const destination = 'https://example.com/article?utm_source=search'
    const html = `<div class="result"><a class="result__a" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent(destination)}">Example article</a><a class="result__snippet">Useful summary</a></div>`
    expect(parseDuckDuckGoResults(html, 5)).toEqual([
      {
        title: 'Example article',
        url: destination,
        description: 'Useful summary',
        source: 'duckduckgo',
        rank: 1
      }
    ])
  })

  it('parses Brave organic result cards without enrichment links', () => {
    const html = `<div id="results"><div class="result-wrapper"><div class="result-content"><a href="https://example.com/guide"><div class="search-snippet-title">Example guide</div></a><div class="generic-snippet"><div class="content">A practical guide.</div></div></div></div><a href="https://search.brave.com/videos?q=x">View all</a></div>`
    expect(parseBraveResults(html, 5)).toEqual([
      {
        title: 'Example guide',
        url: 'https://example.com/guide',
        description: 'A practical guide.',
        source: 'brave',
        rank: 1
      }
    ])
  })

  it('parses Bing cards and decodes tracked destination links', () => {
    const destination = 'https://example.com/reference'
    const wrapped = `https://www.bing.com/ck/a?u=a1${Buffer.from(destination).toString('base64url')}`
    const html = `<ol id="b_results"><li class="b_algo"><h2><a href="${wrapped}">Reference</a></h2><div class="b_caption"><p>Reference description</p></div></li></ol>`
    expect(parseBingResults(html, 5)).toEqual([
      {
        title: 'Reference',
        url: destination,
        description: 'Reference description',
        source: 'bing',
        rank: 1
      }
    ])
  })
})
