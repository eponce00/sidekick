import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, expect, it } from 'vitest'
import { recognizeTextInImages } from './systemOcr'

const folder = mkdtempSync(join(tmpdir(), 'sidekick-ocr-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

// The operating system's own recognizer, on a picture of printed text. Linux has none built in.
it('reads printed text with the operating system OCR', async () => {
  const { createCanvas } = createRequire(import.meta.url)(
    '@napi-rs/canvas'
  ) as typeof import('@napi-rs/canvas')
  const canvas = createCanvas(1400, 300)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#000000'
  context.font = '64px sans-serif'
  context.fillText('INVOICE 4471 TOTAL DUE', 60, 170)
  const image = join(folder, 'page.png')
  writeFileSync(image, canvas.toBuffer('image/png'))
  const result = await recognizeTextInImages([image])
  if (process.platform === 'linux' && !result.ok) {
    expect(result.reason).toBe('unavailable')
    return
  }
  expect(result).toMatchObject({ ok: true })
  expect(result.ok && result.texts[0].replace(/\s+/g, ' ')).toContain('INVOICE 4471')
}, 60_000)
