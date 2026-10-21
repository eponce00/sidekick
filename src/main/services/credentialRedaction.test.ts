import { randomBytes } from 'crypto'
import { describe, expect, it } from 'vitest'
import { CredentialRedactor, secretVariants } from './credentialRedaction'

/** A fresh value per test; no real credential appears anywhere in the suite. */
function generated(length = 24): string {
  return randomBytes(length).toString('base64url').slice(0, length)
}

function redactorFor(...values: string[]): CredentialRedactor {
  const redactor = new CredentialRedactor()
  redactor.setSecrets(values.map((value, index) => ({ alias: `entry-${index}`, value })))
  return redactor
}

describe('CredentialRedactor', () => {
  it('passes text through untouched when nothing is stored', () => {
    const redactor = new CredentialRedactor()
    const data = { a: ['text'] }
    expect(redactor.redact('plain output')).toBe('plain output')
    expect(redactor.redactDeep(data)).toBe(data)
  })

  it('replaces a stored value with its alias', () => {
    const value = generated()
    const redactor = redactorFor(value)
    expect(redactor.redact(`token=${value}; done`)).toBe('token=[secret: entry-0]; done')
  })

  it('catches the encodings a program is likely to print a value in', () => {
    const value = `p@ss w"rd'$&<${generated(12)}>`
    const redactor = redactorFor(value)
    const utf8 = Buffer.from(value, 'utf8')
    const forms = [
      JSON.stringify(value),
      encodeURIComponent(value),
      encodeURIComponent(value).replace(/%20/g, '+'),
      encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
      value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'),
      `'${value.replace(/'/g, `'\\''`)}'`,
      `'${value.replace(/'/g, "''")}'`,
      utf8.toString('base64'),
      utf8.toString('base64url'),
      Buffer.from(value, 'utf16le').toString('base64'),
      utf8.toString('hex'),
      utf8.toString('hex').toUpperCase()
    ]
    for (const form of forms) {
      const output = redactor.redact(`before ${form} after`)
      expect(output, form).toContain('[secret: entry-0]')
      expect(output).not.toContain(value)
    }
  })

  it('finds a value inside a longer Base64 string at every alignment', () => {
    const value = generated(20)
    const redactor = redactorFor(value)
    for (let prefix = 0; prefix < 6; prefix++) {
      for (let suffix = 0; suffix < 4; suffix++) {
        const embedded = Buffer.from(`${'x'.repeat(prefix)}${value}${'y'.repeat(suffix)}`)
        // A Basic authorization header is exactly this shape.
        const header = `Authorization: Basic ${embedded.toString('base64')}`
        const output = redactor.redact(header)
        expect(output, `prefix ${prefix} suffix ${suffix}`).toContain('[secret: entry-0]')
        // Whatever stays readable around the redaction cannot decode back to the value.
        expect(Buffer.from(output.split(' ').pop() ?? '', 'base64').toString()).not.toContain(value)
      }
    }
  })

  it('redacts each line of a multi-line value on its own, but not PEM armor', () => {
    const lines = [generated(30), generated(30)]
    const value = ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----'].join('\n')
    const redactor = redactorFor(value)
    expect(redactor.redact(`log: ${lines[1]}`)).toBe('log: [secret: entry-0]')
    expect(redactor.redact('-----BEGIN PRIVATE KEY-----')).toBe('-----BEGIN PRIVATE KEY-----')
  })

  it('merges overlapping matches into one redaction without leaving pieces behind', () => {
    const first = generated(16)
    const second = first.slice(8) + generated(16)
    const redactor = redactorFor(first, second)
    const output = redactor.redact(`[${first.slice(0, 8)}${second}]`)
    expect(output).toBe('[[secret: entry-0]]')
  })

  it('does not redact values too short to tell apart from ordinary text', () => {
    expect(secretVariants('abc')).toEqual([])
    const redactor = redactorFor('abc')
    expect(redactor.redact('abc abc')).toBe('abc abc')
  })

  it('redacts strings and keys throughout a tool result, leaving only image data alone', () => {
    const value = generated()
    const redactor = redactorFor(value)
    const source = { type: 'data_url', dataUrl: `data:,${value}` }
    const result = {
      title: `Ran ${value}`,
      data: {
        nested: [{ text: value }],
        count: 3,
        // Keys named like the top-level fields are ordinary data deeper down.
        media: value,
        timing: { label: value },
        [value]: 'a key'
      },
      media: [{ type: 'image', source, name: `shot-${value}.png`, description: value }],
      timing: { startedAt: 1 }
    }
    const redacted = redactor.redactDeep(result)
    expect(redacted.title).toBe('Ran [secret: entry-0]')
    expect(redacted.data.nested[0].text).toBe('[secret: entry-0]')
    expect(redacted.data.count).toBe(3)
    expect(JSON.stringify(redacted.data)).not.toContain(value)
    expect(redacted.media[0].source).toBe(source)
    expect(redacted.media[0].name).toBe('shot-[secret: entry-0].png')
    expect(redacted.media[0].description).toBe('[secret: entry-0]')
    expect(result.title).toContain(value)
  })

  it('finds a value a program printed in pieces between terminal escapes', () => {
    const value = generated(24)
    const redactor = redactorFor(value)
    for (const escape of [
      '\x1b[31m',
      '\x1b[0m',
      '\x1b[2K',
      '\x1b]0;title\x07',
      '\x1b]8;;https://x\x1b\\',
      '\x1b7'
    ]) {
      const printed = `key=${value.slice(0, 9)}${escape}${value.slice(9)} done`
      const output = redactor.redact(printed)
      expect(output, JSON.stringify(escape)).toBe('key=[secret: entry-0] done')
    }
    expect(redactor.redact('\x1b[32mplain\x1b[0m')).toBe('\x1b[32mplain\x1b[0m')
  })

  it('hides a value printed without the spaces it was stored with', () => {
    const value = generated()
    const redactor = redactorFor(`  ${value} `)
    expect(redactor.redact(`token=${value};`)).toBe('token=[secret: entry-0];')
  })

  it('redacts a window of text against the text around it', () => {
    const value = generated(30)
    const redactor = redactorFor(value)
    const text = `aaaa${value}bbbb`
    // Windows that cut the value at either edge show the placeholder, not the part inside.
    expect(redactor.redactWindow(text, 10, text.length)).toBe('[secret: entry-0]bbbb')
    expect(redactor.redactWindow(text, 0, 20)).toBe('aaaa[secret: entry-0]')
    expect(redactor.redactWindow(text, 0, 2)).toBe('aa')
    expect(redactor.context).toBeGreaterThanOrEqual(value.length)
  })

  it('counts placeholders only for the values it hides', () => {
    const redactor = redactorFor(generated())
    expect(redactor.placeholders('A=[secret: entry-0] B=[secret: entry-0]')).toBe(2)
    expect(redactor.placeholders('[secret: unknown] [secret: ENTRY-0]')).toBe(0)
  })
})

describe('CredentialRedactionStream', () => {
  it('catches a value split between two chunks at every offset', () => {
    const value = generated(32)
    const redactor = redactorFor(value)
    const text = `start ${value} end`
    for (let cut = 0; cut <= text.length; cut++) {
      const stream = redactor.stream()
      const output = stream.push(text.slice(0, cut)) + stream.push(text.slice(cut)) + stream.flush()
      expect(output, `cut at ${cut}`).toBe('start [secret: entry-0] end')
    }
  })

  it('catches a value delivered one character at a time', () => {
    const value = generated(16)
    const redactor = redactorFor(value)
    const stream = redactor.stream()
    let output = ''
    for (const character of `>>${value}<<`) output += stream.push(character)
    output += stream.flush()
    expect(output).toBe('>>[secret: entry-0]<<')
  })

  it('releases ordinary output at once and holds back only a possible beginning', () => {
    const value = generated(16)
    const redactor = redactorFor(value)
    const stream = redactor.stream()
    expect(stream.push('compiling...\n')).toBe('compiling...\n')
    expect(stream.holding).toBe(false)
    expect(stream.push(`ok ${value.slice(0, 5)}`)).toBe('ok ')
    expect(stream.holding).toBe(true)
    // The last character may wait too, when it could begin an encoded form of the random value.
    const rest = stream.push(`${value.slice(5)} done`)
    expect(rest.startsWith('[secret: entry-0] don')).toBe(true)
    expect(rest + stream.flush()).toBe('[secret: entry-0] done')
  })

  it('never splits a surrogate pair at the hold-back boundary', () => {
    const value = `${generated(8)}\u{1f511}${generated(8)}`
    const redactor = redactorFor(value)
    const stream = redactor.stream()
    const text = `emoji \u{1f511}${value.slice(0, 9)}`
    const emitted = stream.push(text)
    expect(emitted).toBe('emoji \u{1f511}')
    expect(stream.push(`${value.slice(9)}!`)).toBe('[secret: entry-0]!')
  })

  it('catches a value split by an escape that is itself split between chunks', () => {
    const value = generated(24)
    const redactor = redactorFor(value)
    const text = `>> ${value.slice(0, 7)}\x1b[38;5;196m${value.slice(7)}\x1b[0m <<`
    for (let cut = 0; cut <= text.length; cut++) {
      const stream = redactor.stream()
      const output = stream.push(text.slice(0, cut)) + stream.push(text.slice(cut)) + stream.flush()
      expect(output, `cut at ${cut}`).not.toContain(value.slice(7))
      // eslint-disable-next-line no-control-regex
      expect(output.replace(/\x1b\[[0-9;]*m/g, ''), `cut at ${cut}`).toBe('>> [secret: entry-0] <<')
    }
  })

  it('uses the values current at each chunk', () => {
    const redactor = new CredentialRedactor()
    const stream = redactor.stream()
    const value = generated()
    expect(stream.push(`${value}\n`)).toBe(`${value}\n`)
    redactor.setSecrets([{ alias: 'late', value }])
    expect(stream.push(`${value}\n`)).toBe('[secret: late]\n')
  })
})
