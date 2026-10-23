import type { CompanionDevice } from '../../../shared/companion'

/** The blank margin scanners need around a QR code, in modules. */
export const QR_QUIET_ZONE = 4

export interface QrRect {
  x: number
  y: number
  width: number
}

/**
 * The dark modules as one rect per horizontal run, offset by the quiet zone, so a code draws with
 * a few hundred elements and no seams between neighbouring modules.
 */
export function qrRects(modules: boolean[][], quietZone = QR_QUIET_ZONE): QrRect[] {
  const rects: QrRect[] = []
  modules.forEach((row, y) => {
    let start = -1
    for (let x = 0; x <= row.length; x += 1) {
      if (x < row.length && row[x]) {
        if (start < 0) start = x
      } else if (start >= 0) {
        rects.push({ x: start + quietZone, y: y + quietZone, width: x - start })
        start = -1
      }
    }
  })
  return rects
}

/** The code's side in modules, quiet zone included. */
export function qrUnits(modules: boolean[][], quietZone = QR_QUIET_ZONE): number {
  return modules.length + quietZone * 2
}

/**
 * The drawn side in pixels: a whole number of pixels per module near `target`, since a module
 * split across pixels blurs and can make the code harder to scan.
 */
export function qrPixelSize(units: number, target = 208): number {
  if (units <= 0) return 0
  return units * Math.max(2, Math.floor(target / units))
}

/** The time left on a code, as "1:42"; never negative. */
export function formatCountdown(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function relativeTime(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/** What a paired phone's row says about when it was last used. */
export function deviceActivity(
  device: Pick<CompanionDevice, 'connected' | 'lastSeenAt' | 'createdAt'>,
  now = Date.now()
): string {
  if (device.connected) return 'Connected now'
  return `Last used ${relativeTime(device.lastSeenAt ?? device.createdAt, now)}`
}

/** Electron prefixes errors thrown by a main-process handler with the channel name. */
export function companionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
