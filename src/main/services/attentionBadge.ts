import { app, BrowserWindow, nativeImage } from 'electron'

// The Windows overlay is drawn at 32 px and shown at 16 px, so it stays sharp
// on high-density screens.
const SIZE = 32
const SCALE_FACTOR = 2
const BADGE_BGRA = [0x3a, 0x3a, 0xd9] as const
const GLYPH_BGRA = [0xff, 0xff, 0xff] as const

// 3x5 pixel glyphs, one string per row.
const GLYPHS: Record<string, readonly string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '###', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '..#', '..#', '..#'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  '+': ['...', '.#.', '###', '.#.', '...']
}

export function attentionBadgeLabel(count: number): string {
  return count > 9 ? '9+' : String(count)
}

/** A red disc with the count in white, as raw BGRA pixels for `createFromBitmap`. */
export function attentionBadgeBitmap(count: number): Buffer {
  const pixels = Buffer.alloc(SIZE * SIZE * 4)
  const center = (SIZE - 1) / 2
  const radius = SIZE / 2
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const distance = Math.hypot(x - center, y - center)
      const coverage = Math.max(0, Math.min(1, radius - distance))
      if (coverage === 0) continue
      const offset = (y * SIZE + x) * 4
      // Premultiplied alpha keeps the anti-aliased edge from darkening.
      pixels[offset] = Math.round(BADGE_BGRA[0] * coverage)
      pixels[offset + 1] = Math.round(BADGE_BGRA[1] * coverage)
      pixels[offset + 2] = Math.round(BADGE_BGRA[2] * coverage)
      pixels[offset + 3] = Math.round(255 * coverage)
    }
  }
  const label = attentionBadgeLabel(count)
  const scale = label.length === 1 ? 4 : 3
  const gap = scale
  const width = label.length * 3 * scale + (label.length - 1) * gap
  const left = Math.round((SIZE - width) / 2)
  const top = Math.round((SIZE - 5 * scale) / 2)
  ;[...label].forEach((character, index) => {
    const glyph = GLYPHS[character]
    const glyphLeft = left + index * (3 * scale + gap)
    glyph.forEach((row, rowIndex) => {
      ;[...row].forEach((cell, columnIndex) => {
        if (cell !== '#') return
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = glyphLeft + columnIndex * scale + dx
            const y = top + rowIndex * scale + dy
            const offset = (y * SIZE + x) * 4
            pixels[offset] = GLYPH_BGRA[0]
            pixels[offset + 1] = GLYPH_BGRA[1]
            pixels[offset + 2] = GLYPH_BGRA[2]
            pixels[offset + 3] = 255
          }
        }
      })
    })
  })
  return pixels
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
      const overlay =
        shownCount > 0
          ? nativeImage.createFromBitmap(attentionBadgeBitmap(shownCount), {
              width: SIZE,
              height: SIZE,
              scaleFactor: SCALE_FACTOR
            })
          : null
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
