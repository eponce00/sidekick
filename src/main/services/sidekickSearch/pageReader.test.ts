import { describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

import { htmlToMarkdown } from './htmlMarkdown'
import { digestPage, pageText } from './pageDigest'
import { readablePage } from './pageReader'
import type { PageContent } from './types'

const URL_BASE = 'https://example.com/docs/page'

function markdown(html: string): string {
  return htmlToMarkdown(JSDOM.fragment(html), URL_BASE)
}

describe('htmlToMarkdown', () => {
  it('keeps the structure plain text lost', () => {
    const text = markdown(`
      <h2>Install</h2>
      <p>Run <code>npm start</code> and open <a href="/app">the app</a>.</p>
      <pre><code class="language-bash">git clone x
  cd x
npm install</code></pre>
      <ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul>
      <table><tr><th>Name</th><th>Stars</th></tr><tr><td>tool</td><td>2.6k</td></tr></table>
      <script>alert(1)</script><p hidden>secret</p>`)

    expect(text).toContain('## Install')
    expect(text).toContain('Run `npm start` and open [the app](https://example.com/app).')
    // Code keeps its language and its indentation.
    expect(text).toContain('```bash\ngit clone x\n  cd x\nnpm install\n```')
    expect(text).toContain('- One\n- Two\n  - Nested')
    expect(text).toContain('| Name | Stars |\n| --- | --- |\n| tool | 2.6k |')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('secret')
  })
})

describe('readablePage', () => {
  const article = Array.from(
    { length: 8 },
    (_, index) =>
      `<p>Paragraph ${index} of the guide explains how the client streams the device screen to a browser over WebSockets.</p>`
  ).join('')

  it('keeps what sits beside the article and the page details', () => {
    const page = readablePage(
      URL_BASE,
      `<html><head><title>Client</title>
        <meta name="description" content="A web client.">
        <meta property="article:modified_time" content="2026-09-30">
        <script type="application/ld+json">{"@type":"SoftwareApplication","name":"Client","softwareVersion":"3.1","aggregateRating":{"ratingValue":4.6,"ratingCount":120}}</script>
      </head><body>
        <nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
        <aside><a href="/stargazers"><strong>2.6k</strong> stars</a> · Last release 3 days ago</aside>
        <main><article><h1>Client</h1>${article}</article></main>
        <footer>Copyright</footer>
      </body></html>`,
      100_000
    )!

    expect(page.content).toContain('Paragraph 7 of the guide')
    expect(page.elsewhere).toContain('**2.6k** stars')
    expect(page.elsewhere).toContain('Last release 3 days ago')
    // The article is not repeated, and page chrome is not content.
    expect(page.elsewhere).not.toContain('Paragraph 3')
    expect(`${page.content}\n${page.elsewhere}`).not.toMatch(/Pricing|Copyright/)
    expect(page.details).toEqual(
      expect.arrayContaining([
        'Description: A web client.',
        'Updated: 2026-09-30',
        'SoftwareApplication version: 3.1',
        'SoftwareApplication rating: 4.6 (120 ratings)'
      ])
    )
  })
})

describe('digestPage', () => {
  const page = (content: string): PageContent => ({
    url: URL_BASE,
    title: 'Operating system',
    content,
    excerpt: '',
    byline: '',
    siteName: '',
    details: ['Updated: 2026-09-27'],
    elsewhere: '**2.6k** stars',
    success: true
  })

  it('returns a page that fits whole', () => {
    const small = page('## Overview\n\nShort.')
    expect(digestPage(small, 'anything', 6_000)).toEqual({
      text: pageText(small),
      full: pageText(small),
      reduced: false
    })
  })

  it('keeps the part that was asked for from the middle of a long page', () => {
    const filler = (name: string): string =>
      `## ${name}\n\n${Array.from({ length: 40 }, () => `${name} history and background notes.`).join(' ')}`
    const long = page(
      [
        filler('Origins'),
        filler('Hardware'),
        '## Linux kernel\n\nThe kernel is based on long-term support branches; security patches ship monthly.',
        filler('Reception'),
        filler('Licensing')
      ].join('\n\n')
    )

    const digest = digestPage(long, 'Which Linux kernel version and security patch cadence?', 700)

    expect(digest.reduced).toBe(true)
    expect(digest.text).toContain('security patches ship monthly')
    expect(digest.text).toContain('Updated: 2026-09-27')
    expect(digest.text).toMatch(/\[… \d+ parts? of the page left out\]/)
    expect(digest.full).toContain('## Licensing')
  })
})
