import { createCanvas } from '@napi-rs/canvas'
import { mkdtemp, writeFile, realpath, mkdir, symlink, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import { MAX_TOOL_RESULT_MEDIA_BYTES } from '../../shared/agentRuntime'
import { imageContentType, imageHeader } from '../../shared/imageContent'
import { registerVisionToolHandlers } from './agentVisionToolHandlers'
// A whole 1x1 PNG.
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function context(workspaceRoot: string) {
  return {
    runId: 'run-1',
    conversationId: 'conversation-1',
    workspaceRoot,
    signal: new AbortController().signal
  }
}

describe('agent vision tools', () => {
  it('returns project images as typed model media', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-vision-'))
    roots.push(root)
    await writeFile(join(root, 'pixel.png'), PIXEL_PNG)
    const registry = new AgentToolHandlerRegistry()
    registerVisionToolHandlers(registry)
    const result = await registry.execute({
      name: 'view_image',
      title: 'View pixel.png',
      arguments: { path: 'pixel.png' },
      context: context(root)
    })
    expect(result.status).toBe('success')
    expect(result.media?.[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      source: { type: 'data_url', dataUrl: `data:image/png;base64,${PIXEL_PNG.toString('base64')}` }
    })
  })

  it('attaches an image over the tool media cap as a copy that fits it', async () => {
    // Noise compresses like a photo, so this PNG is several times the cap.
    const surface = createCanvas(2400, 1600)
    const surfaceContext = surface.getContext('2d')
    const pixels = surfaceContext.createImageData(2400, 1600)
    let state = 9
    for (let index = 0; index < pixels.data.length; index += 4) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      pixels.data[index] = state & 0xff
      pixels.data[index + 1] = (state >>> 8) & 0xff
      pixels.data[index + 2] = (state >>> 16) & 0xff
      pixels.data[index + 3] = 0xff
    }
    surfaceContext.putImageData(pixels, 0, 0)
    const large = surface.encodeSync('png')
    expect(large.byteLength).toBeGreaterThan(MAX_TOOL_RESULT_MEDIA_BYTES)

    const root = await mkdtemp(join(tmpdir(), 'sidekick-vision-large-'))
    roots.push(root)
    await writeFile(join(root, 'photo.png'), large)
    const registry = new AgentToolHandlerRegistry()
    registerVisionToolHandlers(registry)
    const result = await registry.execute({
      name: 'view_image',
      title: 'View photo.png',
      arguments: { path: 'photo.png' },
      context: context(root)
    })
    expect(result.status).toBe('success')
    const media = result.media?.[0]
    expect(media?.mimeType).toBe('image/jpeg')
    const dataUrl = media?.source.type === 'data_url' ? media.source.dataUrl : ''
    const sent = Buffer.from(dataUrl.split(',')[1], 'base64')
    expect(sent.byteLength).toBeLessThanOrEqual(MAX_TOOL_RESULT_MEDIA_BYTES)
    // Kept at full size; each provider request fits it to the model.
    expect(imageHeader(sent)).toMatchObject({ width: 2400, height: 1600 })
  }, 60_000)

  it('fails a file whose bytes are not a whole image instead of attaching it', async () => {
    // `adb shell screencap -p > screen.png` turns each LF into CRLF; PowerShell `>` re-encodes the
    // bytes as text; a capture can stop early. A provider rejects such an image and ends the run.
    const crlf = Buffer.from(PIXEL_PNG.toString('latin1').replace(/\n/g, '\r\n'), 'latin1')
    const text = Buffer.from(PIXEL_PNG.toString('latin1'), 'utf8')
    const cut = PIXEL_PNG.subarray(0, PIXEL_PNG.length - 20)
    for (const bytes of [crlf, text, cut]) expect(imageContentType(bytes)).toBeUndefined()
    expect(imageContentType(PIXEL_PNG)).toBe('image/png')

    const root = await mkdtemp(join(tmpdir(), 'sidekick-vision-broken-'))
    roots.push(root)
    await writeFile(join(root, 'screen.png'), crlf)
    const registry = new AgentToolHandlerRegistry()
    registerVisionToolHandlers(registry)
    const result = await registry.execute({
      name: 'view_image',
      title: 'View screen.png',
      arguments: { path: 'screen.png' },
      context: context(root)
    })
    expect(result.status).toBe('error')
    expect(result.error?.message).toContain('adb pull')
    expect(result.media).toBeUndefined()
  })

  it('rejects paths outside the active project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-vision-scope-'))
    roots.push(root)
    await mkdir(join(root, 'project'))
    await writeFile(join(root, 'outside.png'), 'fixture')
    const registry = new AgentToolHandlerRegistry()
    registerVisionToolHandlers(registry)
    const result = await registry.execute({
      name: 'view_image',
      title: 'View outside',
      arguments: { path: '../outside.png' },
      context: context(join(root, 'project'))
    })
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('workspace_scope')
  })
})

it.each(['allow', 'deny', 'cancel', 'changed', 'junction'])(
  'handles exact-file external consent: %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-vision-consent-'))
    roots.push(root)
    const project = join(root, 'project'),
      outside = join(root, 'external')
    await mkdir(project)
    await mkdir(outside)
    const image = join(outside, 'pixel.png')
    await writeFile(image, PIXEL_PNG)
    if (mode === 'junction')
      await symlink(
        outside,
        join(project, 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    const ctx = context(project)
    const controller = new AbortController()
    ctx.signal = controller.signal
    const approve = vi.fn(async (path: string) => {
      expect(path).toBe(await realpath(image))
      if (mode === 'cancel') {
        controller.abort()
        return new Promise<boolean>(() => {})
      }
      if (mode === 'changed') await writeFile(image, 'changed-size')
      return mode !== 'deny'
    })
    const registry = new AgentToolHandlerRegistry()
    registerVisionToolHandlers(registry, approve)
    const result = await registry.execute({
      name: 'view_image',
      title: 'Inspect',
      arguments: { path: mode === 'junction' ? 'linked/pixel.png' : image },
      context: ctx
    })
    expect(approve).toHaveBeenCalledTimes(1)
    expect(result.status).toBe(
      mode === 'deny'
        ? 'denied'
        : mode === 'cancel'
          ? 'cancelled'
          : mode === 'changed'
            ? 'error'
            : 'success'
    )
    if (result.status !== 'success') expect(result.media).toBeUndefined()
    else {
      await writeFile(image, 'later-change')
      expect(result.media?.[0].source).toEqual({
        type: 'data_url',
        dataUrl: `data:image/png;base64,${PIXEL_PNG.toString('base64')}`
      })
    }
  }
)
