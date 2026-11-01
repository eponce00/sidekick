import { describe, expect, it } from 'vitest'
import { BROWSER_IMPORT_LIMITS } from '../../../shared/browserLibrary'
import { parseBookmarksFile } from './bookmarksFile'

const CHROME_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="0" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://github.com/" ADD_DATE="1700000000" ICON="data:image/png;base64,AAAA">GitHub</A>
        <DT><H3 ADD_DATE="1700000000">Docs &amp; refs</H3>
        <DL><p>
            <DT><A HREF="https://developer.mozilla.org/?a=1&amp;b=2">MDN &lt;Web&gt; &#8220;Docs&#8221;</A>
        </DL><p>
    </DL><p>
    <DT><A HREF='https://single.example/'>Single quotes</A>
    <DT><a href=https://unquoted.example/ add_date=1>Unquoted, lower case</a>
</DL><p>`

describe('parseBookmarksFile', () => {
  it('reads an exported file with folders, entities and every attribute quoting', () => {
    expect(parseBookmarksFile(CHROME_EXPORT)).toEqual([
      { folder: ['Bookmarks bar'], title: 'GitHub', url: 'https://github.com/' },
      {
        folder: ['Bookmarks bar', 'Docs & refs'],
        title: 'MDN <Web> “Docs”',
        url: 'https://developer.mozilla.org/?a=1&b=2'
      },
      { folder: ['Bookmarks'], title: 'Single quotes', url: 'https://single.example/' },
      { folder: ['Bookmarks'], title: 'Unquoted, lower case', url: 'https://unquoted.example/' }
    ])
  })

  it('names a toolbar folder however the browser titled it', () => {
    const html = `<DL><DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Favoritenleiste</H3><DL><DT><A HREF="https://a.example/">A</A></DL></DL>`
    expect(parseBookmarksFile(html)[0].folder).toEqual(['Bookmarks bar'])
  })

  it('skips bookmarklets, local files and addresses with passwords', () => {
    const html = `<DL>
      <DT><A HREF="javascript:alert(document.cookie)">Bookmarklet</A>
      <DT><A HREF="&#106;avascript:alert(1)">Encoded bookmarklet</A>
      <DT><A HREF="file:///etc/passwd">File</A>
      <DT><A HREF="https://me:secret@example.com/">Password</A>
      <DT><A HREF="https://ok.example/">OK</A>
    </DL>`
    expect(parseBookmarksFile(html).map((bookmark) => bookmark.title)).toEqual(['OK'])
  })

  it('removes markup and control characters from titles', () => {
    const html = `<DL><DT><A HREF="https://a.example/"><b>Bold</b> <img src=x onerror=alert(1)>title&#0;&#x202E;</A></DL>`
    expect(parseBookmarksFile(html)[0].title).toBe('Bold title')
  })

  it('refuses a file that is not a bookmarks file', () => {
    expect(() => parseBookmarksFile('just some text')).toThrow()
    expect(() => parseBookmarksFile('<html><body><p>no lists</p></body></html>')).toThrow()
  })

  it('keeps folder pairs right when lists nest past the depth limit or close too often', () => {
    const deep =
      '<DT><H3>F</H3><DL>'.repeat(200) +
      '<DT><A HREF="https://deep.example/">Deep</A>' +
      '</DL>'.repeat(200)
    const html = `<DL>${deep}</DL></DL></DL><DT><A HREF="https://after.example/">After</A></DL>`
    const bookmarks = parseBookmarksFile(html)
    expect(bookmarks[0].folder).toHaveLength(BROWSER_IMPORT_LIMITS.folderDepth)
    expect(bookmarks[1]).toEqual({
      folder: ['Bookmarks'],
      title: 'After',
      url: 'https://after.example/'
    })
  })

  it('stays linear on input shaped to make a naive scanner quadratic', () => {
    const shapes = [
      '<DL><a' + ' href="x'.repeat(200_000),
      '<DL><a href="https://a.example/">' + '<'.repeat(400_000),
      '<DL>' + '<A HREF="https://a.example/">x'.repeat(50_000),
      '<DL>' + '<h3>'.repeat(100_000) + '<a>'
    ]
    for (const html of shapes) {
      const started = Date.now()
      try {
        parseBookmarksFile(html)
      } catch {
        // Refusing the file is fine; taking long is not.
      }
      expect(Date.now() - started).toBeLessThan(2000)
    }
  })
})
