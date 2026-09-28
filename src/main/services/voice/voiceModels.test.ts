import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_MODELS, VoiceModelStore, type VoiceModelManifest } from './voiceModels'

const sha = (value: string): string => createHash('sha256').update(value).digest('hex')

function manifest(files: Record<string, string>): VoiceModelManifest {
  return {
    id: 'speech',
    folder: 'fixture',
    files: Object.entries(files).map(([name, body]) => ({
      name,
      url: `https://models.test/${name}`,
      size: Buffer.byteLength(body),
      sha256: sha(body)
    }))
  }
}

function serve(files: Record<string, string>) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const body = files[url.split('/').pop()!]
    const range = (init.headers as Record<string, string>)?.Range
    const offset = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0
    return new Response(body.slice(offset), { status: range ? 206 : 200 })
  })
}

describe('VoiceModelStore', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidekick-voice-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('pins every shipped model file to a size and hash', () => {
    for (const model of Object.values(VOICE_MODELS)) {
      for (const file of model.files) {
        expect(file.url).toMatch(/^https:\/\/(huggingface\.co|github\.com)\//)
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(file.size).toBeGreaterThan(0)
      }
    }
  })

  it('downloads, verifies and marks a model installed', async () => {
    const files = { 'a.onnx': 'alpha model', 'b.json': '{"b":1}' }
    const store = new VoiceModelStore(root, serve(files))
    const model = manifest(files)
    expect(await store.isInstalled(model)).toBe(false)
    const progress: number[] = []
    await store.download(model, (bytes) => progress.push(bytes), new AbortController().signal)
    expect(await store.isInstalled(model)).toBe(true)
    expect(await readFile(store.path(model, 'a.onnx'), 'utf8')).toBe('alpha model')
    expect(progress.at(-1)).toBe(model.files[0].size + model.files[1].size)
    expect(await store.initialState(model)).toMatchObject({ status: 'ready' })
  })

  it('resumes an interrupted file from where it stopped', async () => {
    const files = { 'a.onnx': 'resumable model body' }
    const fetcher = serve(files)
    const store = new VoiceModelStore(root, fetcher)
    const model = manifest(files)
    await store.download(model, () => undefined, new AbortController().signal).catch(() => {})
    await rm(store.path(model, 'a.onnx'))
    await rm(join(store.directory(model), '.complete.json'))
    await writeFile(`${store.path(model, 'a.onnx')}.partial`, 'resumable ')
    expect(await store.initialState(model)).toMatchObject({ status: 'missing', receivedBytes: 10 })
    fetcher.mockClear()
    await store.download(model, () => undefined, new AbortController().signal)
    expect(fetcher).toHaveBeenCalledWith(
      'https://models.test/a.onnx',
      expect.objectContaining({ headers: { Range: 'bytes=10-' } })
    )
    expect(await readFile(store.path(model, 'a.onnx'), 'utf8')).toBe('resumable model body')
  })

  it('refuses a file whose contents changed upstream', async () => {
    const model = manifest({ 'a.onnx': 'expected' })
    const store = new VoiceModelStore(root, serve({ 'a.onnx': 'tampered' }))
    await expect(
      store.download(model, () => undefined, new AbortController().signal)
    ).rejects.toThrow('did not match')
    expect(await store.isInstalled(model)).toBe(false)
  })
})
