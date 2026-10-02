import { app, BrowserWindow, nativeImage } from 'electron'

// The Windows overlay box is 16 device-independent pixels. It is drawn for each display scale
// up to 400%, so Windows never stretches a smaller image into a blurry one.
const OVERLAY_SIZE = 16
const SCALE_FACTORS = [1, 1.25, 1.5, 2, 2.5, 3, 4] as const
// SideKick's accent, set off by a dark ring so it reads on any icon and taskbar.
const DOT_BGRA = [0xbd, 0xd4, 0x3b] as const
const RING_BGRA = [0x14, 0x11, 0x0f] as const
const DOT_RADIUS = 0.3
const RING_WIDTH = 0.09

/**
 * A small accent dot in a dark ring, centred in a square of `size` pixels, as premultiplied
 * BGRA for `createFromBitmap`. The count is not drawn: at this size digits are blocky, and the
 * taskbar's description says how many conversations are waiting.
 */
export function attentionDotBitmap(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4)
  const center = size / 2
  const dot = size * DOT_RADIUS
  const outer = dot + size * RING_WIDTH
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Distance from the pixel's centre; coverage within half a pixel smooths the edges.
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center)
      const alpha = Math.max(0, Math.min(1, outer - distance + 0.5))
      if (alpha === 0) continue
      const inDot = Math.max(0, Math.min(1, dot - distance + 0.5))
      const offset = (y * size + x) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        const color = DOT_BGRA[channel] * inDot + RING_BGRA[channel] * (1 - inDot)
        pixels[offset + channel] = Math.round(color * alpha)
      }
      pixels[offset + 3] = Math.round(255 * alpha)
    }
  }
  return pixels
}

function attentionOverlay(): Electron.NativeImage {
  const image = nativeImage.createEmpty()
  for (const scaleFactor of SCALE_FACTORS) {
    const size = Math.round(OVERLAY_SIZE * scaleFactor)
    image.addRepresentation({
      scaleFactor,
      width: size,
      height: size,
      buffer: attentionDotBitmap(size)
    })
  }
  return image
}

let shownCount = 0

/**
 * Shows how many conversations are waiting on the user: a taskbar overlay on
 * Windows, the Dock badge on macOS, the launcher count on Linux desktops that
 * support one. A count of zero clears it.
 */
export function applyAttentionBadge(count: number, platform = process.platform): void {
  shownCount = Math.max(0, Math.floor(count))
  try {
    if (platform === 'win32') {
      const overlay = shownCount > 0 ? attentionOverlay() : null
      const description =
        shownCount === 1
          ? '1 conversation is waiting for you'
          : shownCount > 1
            ? `${shownCount} conversations are waiting for you`
            : ''
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.setOverlayIcon(overlay, description)
      }
    } else if (platform === 'darwin') {
      app.dock?.setBadge(shownCount > 0 ? String(shownCount) : '')
    } else {
      app.setBadgeCount(shownCount)
    }
  } catch (error) {
    console.warn('[Badge] Could not update the attention badge:', error)
  }
}

/** A newly opened window starts without the overlay; give it the current one. */
export function refreshAttentionBadge(platform = process.platform): void {
  if (shownCount > 0) applyAttentionBadge(shownCount, platform)
}
