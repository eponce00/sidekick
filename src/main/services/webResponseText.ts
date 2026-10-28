/** Where an HTML or XML document states its own encoding, within the bytes a browser checks. */
const DECLARED_IN_DOCUMENT = [
  /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([\w.:-]+)/i,
  /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([\w.:-]+)/i
]

/**
 * Decodes a web response by its byte-order mark, then its declared charset, then, for HTML or XML,
 * the encoding the document declares in its first bytes, then as UTF-8. Read as UTF-8, a page in
 * windows-1252 or Shift_JIS came back as replacement characters.
 */
export function decodeWebText(bytes: Uint8Array, contentType: string): string {
  let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1]
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = 'utf-8'
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = 'utf-16be'
  else if (!charset && (!contentType || /html|xml/i.test(contentType))) {
    const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1')
    charset = DECLARED_IN_DOCUMENT.map((pattern) => pattern.exec(head)?.[1]).find(Boolean)
    // A declaration readable as ASCII cannot be UTF-16; browsers read it as UTF-8.
    if (charset && /^utf-?16/i.test(charset)) charset = 'utf-8'
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}
