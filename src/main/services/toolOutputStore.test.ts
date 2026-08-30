import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { boundToolOutputPreview, ToolOutputStore } from './toolOutputStore'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('ToolOutputStore', () => {
  it('bounds by lines and bytes without persisting small output', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'sidekick-output-'))
    roots.push(root)
    const store = new ToolOutputStore(root)
    const small = await store.apply('hello')
    expect(small).toMatchObject({ content: 'hello', output: { truncated: false } })
    expect(await fs.readdir(root)).toEqual([])

    const bounded = boundToolOutputPreview('1\n2\n3\n4', { maxLines: 2, maxBytes: 1_024 })
    expect(bounded.truncated).toBe(true)
    expect(bounded.content).toContain('lines omitted')
  })

  it('retains truncated output behind an opaque paged handle', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'sidekick-output-'))
    roots.push(root)
    const store = new ToolOutputStore(root)
    const original = 'x'.repeat(8_000)
    const bounded = await store.apply(original, { maxBytes: 1_024, maxLines: 2_000 })
    expect(bounded.output.truncated).toBe(true)
    expect(bounded.content).toContain('tool_output')

    const handle = bounded.output.fullOutputHandle!
    const first = await store.read(handle, 0, 2_000)
    const second = await store.read(handle, first.nextOffset!, 50_000)
    expect(first.content + second.content).toBe(original)
    expect(second.nextOffset).toBeNull()
    await expect(store.read('../escape')).rejects.toThrow('Invalid tool output handle')
  })

  it('bounds token-dense single-line output before exposing it to the model', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'sidekick-output-'))
    roots.push(root)
    const store = new ToolOutputStore(root)
    const dense = JSON.stringify({
      coordinates: Array.from({ length: 5_000 }, (_, index) => [index / 100, -index / 100])
    })

    const bounded = await store.apply(dense, {
      maxBytes: 100 * 1024,
      maxLines: 10_000,
      maxTokens: 1_024
    })

    expect(bounded.output).toMatchObject({
      truncated: true,
      originalEstimatedTokens: expect.any(Number),
      returnedEstimatedTokens: expect.any(Number),
      fullOutputHandle: expect.any(String)
    })
    expect(bounded.output.originalEstimatedTokens).toBeGreaterThan(10_000)
    expect(bounded.output.returnedEstimatedTokens).toBeLessThanOrEqual(1_024)
    expect(bounded.content).toContain('tokens omitted')
    expect(bounded.content).toContain('tool_output')
  })
})
