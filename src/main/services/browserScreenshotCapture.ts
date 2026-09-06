/** CDP capture policy only: session ownership, target resolution, cancellation,
 * viewport capture and artifact lifetime remain with the browser service. */
export const MAX_MODEL_SCREENSHOT_BYTES = 8 * 1024 * 1024
const MAX_SCREENSHOT_DIMENSION = 16_384
const MAX_SCREENSHOT_PIXELS = 40_000_000

export interface BrowserCaptureBox {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserCaptureClip extends BrowserCaptureBox {
  scale: number
}

export interface BrowserLayoutMetrics {
  contentSize?: { x?: number; y?: number; width: number; height: number }
  cssContentSize?: { x?: number; y?: number; width: number; height: number }
}

export interface BrowserScreenshotDriver {
  layoutMetrics(): Promise<BrowserLayoutMetrics>
  capture(clip: BrowserCaptureClip): Promise<{ data: string }>
}

function screenshotScale(width: number, height: number): number {
  if (width * height <= MAX_SCREENSHOT_PIXELS) return 1
  return Math.max(0.1, Math.sqrt(MAX_SCREENSHOT_PIXELS / (width * height)))
}

export async function captureBrowserScreenshot(
  driver: BrowserScreenshotDriver,
  elementBox?: BrowserCaptureBox
): Promise<{ png: Buffer; width: number; height: number }> {
  let clip: BrowserCaptureClip
  if (elementBox) {
    clip = { ...elementBox, scale: screenshotScale(elementBox.width, elementBox.height) }
  } else {
    const metrics = await driver.layoutMetrics()
    const size = metrics.cssContentSize ?? metrics.contentSize
    if (!size) throw new Error('Unable to determine full-page screenshot dimensions')
    const width = Math.max(1, Math.min(MAX_SCREENSHOT_DIMENSION, Math.ceil(size.width)))
    const height = Math.max(1, Math.min(MAX_SCREENSHOT_DIMENSION, Math.ceil(size.height)))
    clip = {
      x: size.x ?? 0,
      y: size.y ?? 0,
      width,
      height,
      scale: screenshotScale(width, height)
    }
  }
  let png = Buffer.alloc(0)
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await driver.capture(clip)
    png = Buffer.from(response.data, 'base64')
    if (png.byteLength <= MAX_MODEL_SCREENSHOT_BYTES) break
    clip.scale = Math.max(
      0.1,
      clip.scale * Math.min(0.8, Math.sqrt(MAX_MODEL_SCREENSHOT_BYTES / png.byteLength) * 0.9)
    )
  }
  if (!png.length) throw new Error('Chromium returned an empty screenshot')
  if (png.byteLength > MAX_MODEL_SCREENSHOT_BYTES) {
    throw new Error('Browser screenshot exceeds the 8 MiB vision input limit after downscaling')
  }
  return {
    png,
    width: Math.max(1, Math.round(clip.width * clip.scale)),
    height: Math.max(1, Math.round(clip.height * clip.scale))
  }
}
