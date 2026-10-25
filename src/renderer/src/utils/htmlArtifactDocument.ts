/**
 * An HTML artifact as the complete document the HTML sandbox writes, with `head` placed before
 * anything the artifact brings so its own styles come later and win. A fragment is wrapped in a
 * document, and every document gets a doctype: without one the page lays out in quirks mode, where
 * its height cannot be measured.
 */
export function buildArtifactDocument(code: string, head: string): string {
  const trimmed = code.trim()
  const doctype = trimmed.match(/^<!doctype[^>]*>/i)?.[0] || '<!DOCTYPE html>'
  const body = trimmed.replace(/^<!doctype[^>]*>/i, '').trim()
  const html = /<html[\s>]/i.test(body)
    ? body
    : `<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body>
${body}
</body>
</html>`
  const withHead = /<head[\s>]/i.test(html)
    ? html.replace(/<head([^>]*)>/i, (tag) => `${tag}\n${head}`)
    : html.replace(/<html([^>]*)>/i, (tag) => `${tag}\n<head>${head}</head>`)
  return `${doctype}\n${withHead}`
}

/** An SVG artifact as an HTML one: centered, and never wider than the reply. */
export function svgArtifactDocument(svg: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    @layer sidekick {
      body > svg {
        display: block;
        max-width: 100%;
        margin: 0 auto;
      }
    }
  </style>
</head>
<body>
${svg.trim()}
</body>
</html>`
}
