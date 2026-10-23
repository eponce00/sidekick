import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { planToolOutputCut, ToolOutputStore } from './toolOutputStore'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function store(): Promise<ToolOutputStore> {
  const root = await fs.mkdtemp(join(tmpdir(), 'sidekick-output-'))
  roots.push(root)
  return new ToolOutputStore(root)
}

const numbered = (count: number): string =>
  Array.from({ length: count }, (_, line) => `line ${String(line).padStart(5, '0')} of the log`)
    .join('\n')
    .concat('\n')

/** The bytes of `text` from `offset`, as `tool_output` would return them. */
function from(text: string, offset: number, length: number): string {
  return Buffer.from(text, 'utf8')
    .subarray(offset, offset + length)
    .toString('utf8')
}

describe('ToolOutputStore', () => {
  it('passes small output through without keeping a copy', async () => {
    const outputs = await store()
    const small = await outputs.apply('hello')
    expect(small).toMatchObject({ content: 'hello', output: { truncated: false } })
  })

  it('cuts head and tail on whole lines, and the omitted range is exactly what is missing', () => {
    const original = numbered(5_000)
    const cut = planToolOutputCut(original, { maxLines: 200 })

    expect(cut.truncated).toBe(true)
    expect(cut.head.endsWith('\n')).toBe(true)
    expect(cut.tail.startsWith('line ')).toBe(true)
    expect(cut.head + from(original, cut.omittedOffset, cut.omittedBytes) + cut.tail).toBe(original)
    expect(cut.omittedOffset).toBe(Buffer.byteLength(cut.head))
    expect(cut.omittedLines).toBe(5_000 - (cut.head + cut.tail).split('\n').length + 1)
  })

  it('points tool_output at the first byte left out, not at the size of the preview', async () => {
    // The continuation offset was the preview's length, which for a head-and-tail cut lands
    // somewhere in the part the model had already seen.
    const outputs = await store()
    const original = numbered(5_000)
    const bounded = await outputs.apply(original, { maxLines: 200 })
    const offset = bounded.output.continuation?.offset as number
    const handle = bounded.output.fullOutputHandle!

    const head = bounded.content.slice(0, bounded.content.indexOf('[… SideKick'))
    expect(offset).toBe(Buffer.byteLength(head))
    expect(bounded.content).toContain(`handle "${handle}" and offset ${offset}`)
    expect(bounded.content).toMatch(/left out [\d,]+ lines \([\d,]+ bytes\) here/)

    const next = await outputs.read(handle, offset, 1_024)
    const firstMissing = original.slice(head.length).split('\n')[0]
    expect(next.content.startsWith(firstMissing)).toBe(true)
    expect(head.endsWith(`${firstMissing}\n`)).toBe(false)
  })

  it('keeps an opaque paged handle whose pieces join back into the original', async () => {
    const outputs = await store()
    const original = 'x'.repeat(8_000)
    const bounded = await outputs.apply(original, { maxBytes: 1_024, maxLines: 2_000 })
    expect(bounded.output.truncated).toBe(true)
    expect(bounded.content).toContain('tool_output')

    const handle = bounded.output.fullOutputHandle!
    const first = await outputs.read(handle, 0, 2_000)
    const second = await outputs.read(handle, first.nextOffset!, 50_000)
    expect(first.content + second.content).toBe(original)
    expect(second.nextOffset).toBeNull()
    await expect(outputs.read('../escape')).rejects.toThrow('Invalid tool output handle')
  })

  it('bounds token-dense single-line output inside the line', async () => {
    const outputs = await store()
    const dense = JSON.stringify({
      coordinates: Array.from({ length: 5_000 }, (_, index) => [index / 100, -index / 100])
    })

    const bounded = await outputs.apply(dense, {
      maxBytes: 100 * 1024,
      maxLines: 10_000,
      maxTokens: 1_024
    })

    expect(bounded.output).toMatchObject({ truncated: true, fullOutputHandle: expect.any(String) })
    expect(bounded.output.originalEstimatedTokens).toBeGreaterThan(10_000)
    expect(bounded.output.returnedEstimatedTokens).toBeLessThanOrEqual(1_024)
    const offset = bounded.output.continuation?.offset as number
    expect(dense.startsWith(bounded.content.slice(0, bounded.content.indexOf('\n[…')))).toBe(true)
    expect(offset).toBe(
      Buffer.byteLength(bounded.content.slice(0, bounded.content.indexOf('\n[…')))
    )
  })

  it('shows the start and end of a line too long to show whole, between short lines', () => {
    // A website's tool result is one line of JSON between its block's tags. Whole lines alone
    // kept only the opening tag and the closing one, so the model saw none of the result.
    const json = JSON.stringify({
      ok: true,
      editor: {
        editorToken: 'token-123',
        fields: Array.from({ length: 600 }, (_, index) => ({ id: `control-${index}` }))
      },
      last: 'end-marker'
    })
    const original = `<webmcp_result tool="read_editor">\n${json}\n</webmcp_result>\nA note.`
    const cut = planToolOutputCut(original, { maxBytes: 8 * 1024, maxTokens: 1_024 })

    expect(cut.truncated).toBe(true)
    expect(cut.head).toContain('"editorToken":"token-123"')
    expect(cut.tail).toContain('"last":"end-marker"}\n</webmcp_result>\nA note.')
    expect(cut.head + from(original, cut.omittedOffset, cut.omittedBytes) + cut.tail).toBe(original)
    expect(cut.omittedLines).toBe(0)
    expect(Buffer.byteLength(cut.head + cut.tail)).toBeLessThanOrEqual(8 * 1024)

    // A line that fits the room still never shows cut.
    const lines = planToolOutputCut(numbered(5_000), { maxLines: 200 })
    expect(lines.head.endsWith('\n')).toBe(true)
    expect(lines.tail.startsWith('line ')).toBe(true)
  })

  it('finds text in a kept result, with its offset and the text around it', async () => {
    const outputs = await store()
    const json = JSON.stringify({
      fields: Array.from({ length: 2_000 }, (_, index) => ({ id: `control-${index}` })),
      editorToken: 'token-123'
    })
    const handle = await outputs.save(`<webmcp_result>\n${json}\n</webmcp_result>`)

    const found = await outputs.search(handle, 'EDITORTOKEN')
    expect(found.totalMatches).toBe(1)
    expect(found.matches[0].text).toContain('"editorToken":"token-123"')
    const read = await outputs.read(handle, found.matches[0].offset, 1_024)
    expect(read.content.startsWith('editorToken')).toBe(true)

    // Only the first matches come back; every one is counted. Text is matched as written.
    const many = await outputs.search(handle, '"id":"control-1')
    expect(many.matches).toHaveLength(20)
    expect(many.totalMatches).toBe(1_111)
    expect((await outputs.search(handle, '.*')).totalMatches).toBe(0)
    expect((await outputs.search(handle, 'missing')).matches).toEqual([])
  })

  it('never finds a stored value that a read would hide', async () => {
    const redactor = {
      context: 0,
      redact: (text: string) => text.replaceAll('s3cret-value', '[secret: api]'),
      redactWindow: (text: string) => text.replaceAll('s3cret-value', '[secret: api]')
    } as unknown as ConstructorParameters<typeof ToolOutputStore>[2]
    const root = await fs.mkdtemp(join(tmpdir(), 'sidekick-output-'))
    roots.push(root)
    // Kept before the value was stored, so the file still holds it.
    const handle = await new ToolOutputStore(root).save('key=s3cret-value;')
    const outputs = new ToolOutputStore(root, Date.now, redactor)
    expect((await outputs.search(handle, 's3cret')).totalMatches).toBe(0)
    expect((await outputs.search(handle, 'key=')).matches[0].text).toBe('key=[secret: api];')
  })

  it('bounds each section on its own and points each note into the stored layout', async () => {
    const outputs = await store()
    const stdout = numbered(20_000)
    const stderr = 'warning: passive mode\n'
    const bounded = await outputs.applySections(
      'Exit code: 0',
      [
        { name: 'stdout', text: stdout },
        { name: 'stderr', text: stderr }
      ],
      {
        describeCut: (section, amount, handle, offset) =>
          `${amount} of ${section.name} left out, handle ${handle}, offset ${offset}`
      }
    )

    expect(bounded.output.truncated).toBe(true)
    expect(bounded.output.returnedEstimatedTokens).toBeLessThanOrEqual(8_192)
    expect(bounded.content.startsWith('Exit code: 0\n<stdout>\nline 00000 of the log\n')).toBe(true)
    // The small stream stays whole, and each stream is closed on its own line.
    expect(bounded.content).toContain('\n</stdout>\n<stderr>\nwarning: passive mode\n</stderr>\n')
    expect(bounded.sections).toEqual([
      expect.objectContaining({ name: 'stdout', truncated: true }),
      { name: 'stderr', truncated: false }
    ])

    const { omittedOffset } = bounded.sections[0]
    expect(bounded.content).toContain(`offset ${omittedOffset}`)
    const shownHead = bounded.content.slice('Exit code: 0\n<stdout>\n'.length).split('[… ')[0]
    const read = await outputs.read(bounded.output.fullOutputHandle!, omittedOffset, 1_024)
    expect(read.content.startsWith(stdout.slice(shownHead.length).split('\n')[0] + '\n')).toBe(true)
    const whole = await outputs.read(bounded.output.fullOutputHandle!, 0, 64)
    expect(whole.content.startsWith('Exit code: 0\n<stdout>\n')).toBe(true)
  })

  it('reads a handle copied with the quotes, spaces or period around it', async () => {
    // Two reads on a work PC failed as "Invalid tool output handle"; a note then put a period
    // right after the handle.
    const outputs = await store()
    const handle = await outputs.save('kept')
    for (const copied of [` ${handle}\n`, `"${handle}"`, `${handle}.`, `<${handle}>,`]) {
      expect((await outputs.read(copied)).content).toBe('kept')
    }
    await expect(outputs.read(`../${handle}`)).rejects.toThrow('Invalid tool output handle')
    await expect(outputs.read(`${handle}/../x`)).rejects.toThrow('Invalid tool output handle')
  })

  it('starts and ends a read on whole characters', async () => {
    const outputs = await store()
    const handle = await outputs.save('ab' + 'é'.repeat(2_000))
    // Offset 3 is the second byte of the first é.
    const read = await outputs.read(handle, 3, 1_025)
    expect(read.offset).toBe(2)
    expect(read.content).not.toContain('�')
    expect(Buffer.byteLength(read.content) % 2).toBe(0)
    const next = await outputs.read(handle, read.nextOffset!, 1_024)
    expect(next.content.startsWith('é')).toBe(true)
  })
})
