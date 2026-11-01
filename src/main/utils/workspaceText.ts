/**
 * How a project file's bytes become the text the agent reads and edits, and back. The read tool
 * and the mutation service share this, so a file one calls text the other can edit without
 * changing anything it did not mean to change.
 */

/** Bytes inspected to tell text from binary; the read tool looks at no more. */
export const TEXT_SAMPLE_BYTES = 8_192

export type WorkspaceTextEncoding = 'utf8' | 'utf16le'

export interface WorkspaceTextFormat {
  encoding: WorkspaceTextEncoding
  /** The file starts with a byte order mark, which is not part of its text. */
  bom: boolean
  /**
   * Every line break is a lone CR (classic Mac). The text uses LF instead, so edits and patches
   * see the same lines the read tool shows; encoding turns them back into CR.
   */
  crLineBreaks: boolean
}

export interface WorkspaceText {
  text: string
  format: WorkspaceTextFormat
}

export const DEFAULT_TEXT_FORMAT: WorkspaceTextFormat = {
  encoding: 'utf8',
  bom: false,
  crLineBreaks: false
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16LE_BOM = Buffer.from([0xff, 0xfe])

/**
 * The encoding of a file from its first bytes, or undefined for binary. UTF-16 is recognized
 * only by its byte order mark, which Windows tools write; any other NUL byte means binary.
 */
export function sampleTextEncoding(sample: Buffer): WorkspaceTextEncoding | undefined {
  if (sample.subarray(0, 2).equals(UTF16LE_BOM)) return 'utf16le'
  return sample.includes(0) ? undefined : 'utf8'
}

/** Leading byte-order-mark bytes for an encoding, when the sample starts with them. */
export function byteOrderMarkLength(sample: Buffer, encoding: WorkspaceTextEncoding): number {
  const bom = encoding === 'utf16le' ? UTF16LE_BOM : UTF8_BOM
  return sample.subarray(0, bom.length).equals(bom) ? bom.length : 0
}

/**
 * The text of a whole file, or undefined when it is not text that would survive a round trip:
 * binary, or bytes that are not valid in its encoding. Re-encoding the text unchanged gives back
 * the same bytes.
 */
export function decodeWorkspaceText(bytes: Buffer): WorkspaceText | undefined {
  const encoding = sampleTextEncoding(bytes.subarray(0, TEXT_SAMPLE_BYTES))
  if (!encoding) return undefined
  const bomLength = byteOrderMarkLength(bytes, encoding)
  let text: string
  try {
    text = new TextDecoder(encoding === 'utf8' ? 'utf-8' : 'utf-16le', {
      fatal: true,
      ignoreBOM: true
    }).decode(bytes.subarray(bomLength))
  } catch {
    return undefined
  }
  const crLineBreaks = text.includes('\r') && !text.includes('\n')
  return {
    text: crLineBreaks ? text.replaceAll('\r', '\n') : text,
    format: { encoding, bom: bomLength > 0, crLineBreaks }
  }
}

export function encodeWorkspaceText(text: string, format: WorkspaceTextFormat): Buffer {
  let body = format.bom && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (format.crLineBreaks) body = body.replace(/\r?\n/g, '\r')
  const encoded = Buffer.from(body, format.encoding)
  if (!format.bom) return encoded
  return Buffer.concat([format.encoding === 'utf16le' ? UTF16LE_BOM : UTF8_BOM, encoded])
}
