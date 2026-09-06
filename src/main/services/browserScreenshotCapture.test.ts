import { expect, it, vi } from 'vitest'
import {
  captureBrowserScreenshot,
  MAX_MODEL_SCREENSHOT_BYTES,
  type BrowserCaptureClip,
  type BrowserLayoutMetrics
} from './browserScreenshotCapture'

function fixture(
  metrics: BrowserLayoutMetrics = { cssContentSize: { width: 1280, height: 800 } },
  sizes = [3]
) {
  const clips: BrowserCaptureClip[] = []
  const layoutMetrics = vi.fn(async () => metrics)
  const capture = vi.fn(async (clip: BrowserCaptureClip) => {
    clips.push({ ...clip })
    return {
      data: Buffer.alloc(sizes[Math.min(clips.length - 1, sizes.length - 1)], 1).toString('base64')
    }
  })
  return { driver: { layoutMetrics, capture }, clips }
}

it('prefers CSS metrics, preserving origins and rounding dimensions upward', async () => {
  const { driver, clips } = fixture({
    cssContentSize: { x: -2.5, y: 4.5, width: 100.1, height: 200.2 },
    contentSize: { width: 999, height: 999 }
  })
  const result = await captureBrowserScreenshot(driver)
  expect(clips).toEqual([{ x: -2.5, y: 4.5, width: 101, height: 201, scale: 1 }])
  expect(result).toEqual({ png: Buffer.from([1, 1, 1]), width: 101, height: 201 })
})

it('falls back to legacy content metrics and defaults absent origins to zero', async () => {
  const { driver, clips } = fixture({ contentSize: { width: 10, height: 20 } })
  await captureBrowserScreenshot(driver)
  expect(clips).toEqual([{ x: 0, y: 0, width: 10, height: 20, scale: 1 }])
})

it('rejects absent metrics before issuing a screenshot', async () => {
  const { driver } = fixture({})
  await expect(captureBrowserScreenshot(driver)).rejects.toThrow(
    'Unable to determine full-page screenshot dimensions'
  )
  expect(driver.capture).not.toHaveBeenCalled()
})

it('keeps the full-page dimension and pixel bounds unchanged', async () => {
  const { driver, clips } = fixture({ cssContentSize: { width: 20000, height: 20000 } })
  const result = await captureBrowserScreenshot(driver)
  const scale = Math.sqrt(40000000 / (16384 * 16384))
  expect(clips).toEqual([{ x: 0, y: 0, width: 16384, height: 16384, scale }])
  expect(result.width).toBe(Math.round(16384 * scale))
  expect(result.height).toBe(result.width)
})

it('retains the minimum full-page dimension of one pixel', async () => {
  const { driver, clips } = fixture({ contentSize: { width: 0, height: -5 } })
  await captureBrowserScreenshot(driver)
  expect(clips).toEqual([{ x: 0, y: 0, width: 1, height: 1, scale: 1 }])
})

it('uses the resolved element box verbatim without asking for page metrics', async () => {
  const { driver, clips } = fixture()
  const box = { x: 12.25, y: 42.75, width: 20000.5, height: 200.25 }
  const result = await captureBrowserScreenshot(driver, box)
  expect(driver.layoutMetrics).not.toHaveBeenCalled()
  expect(clips).toEqual([{ ...box, scale: 1 }])
  expect(result.width).toBe(20001)
  expect(box).toEqual({ x: 12.25, y: 42.75, width: 20000.5, height: 200.25 })
})

it('accepts the exact eight-MiB byte boundary without recapture', async () => {
  const { driver } = fixture(undefined, [MAX_MODEL_SCREENSHOT_BYTES])
  const result = await captureBrowserScreenshot(driver)
  expect(result.png.byteLength).toBe(8 * 1024 * 1024)
  expect(driver.capture).toHaveBeenCalledTimes(1)
})

it('downscales oversized captures with the existing ratio and reports accepted dimensions', async () => {
  const bytes = MAX_MODEL_SCREENSHOT_BYTES * 2
  const { driver, clips } = fixture(undefined, [bytes, 3])
  const result = await captureBrowserScreenshot(driver)
  const scale = Math.sqrt(MAX_MODEL_SCREENSHOT_BYTES / bytes) * 0.9
  expect(clips.map((clip) => clip.scale)).toEqual([1, scale])
  expect(result.width).toBe(Math.round(1280 * scale))
  expect(result.height).toBe(Math.round(800 * scale))
})

it('caps oversized capture attempts at four and never falls below scale 0.1', async () => {
  const { driver, clips } = fixture(undefined, [MAX_MODEL_SCREENSHOT_BYTES + 1])
  await expect(
    captureBrowserScreenshot(driver, { x: 0, y: 0, width: 100000, height: 100000 })
  ).rejects.toThrow('Browser screenshot exceeds the 8 MiB vision input limit after downscaling')
  expect(driver.capture).toHaveBeenCalledTimes(4)
  expect(clips.map((clip) => clip.scale)).toEqual([0.1, 0.1, 0.1, 0.1])
})

it('rejects an empty capture without retrying', async () => {
  const { driver } = fixture(undefined, [0])
  await expect(captureBrowserScreenshot(driver)).rejects.toThrow(
    'Chromium returned an empty screenshot'
  )
  expect(driver.capture).toHaveBeenCalledTimes(1)
})

it.each(['layoutMetrics', 'capture'] as const)(
  'propagates %s failure without capture retry',
  async (operation) => {
    const { driver } = fixture()
    const failure = new Error('operation cancelled')
    driver[operation].mockRejectedValueOnce(failure)
    await expect(captureBrowserScreenshot(driver)).rejects.toBe(failure)
    expect(driver.capture).toHaveBeenCalledTimes(operation === 'capture' ? 1 : 0)
  }
)
