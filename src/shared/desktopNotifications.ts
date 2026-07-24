export const MAX_DESKTOP_NOTIFICATION_BODY_BYTES = 220

export interface DesktopNotificationRequest {
  body: string
  silent: boolean
}

export function normalizeDesktopNotificationBody(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  if (!normalized) return 'Response completed.'

  const encoder = new TextEncoder()
  if (encoder.encode(normalized).byteLength <= MAX_DESKTOP_NOTIFICATION_BODY_BYTES) {
    return normalized
  }

  const suffix = '…'
  const suffixBytes = encoder.encode(suffix).byteLength
  let result = ''
  let bytes = 0
  for (const character of normalized) {
    const characterBytes = encoder.encode(character).byteLength
    if (bytes + characterBytes + suffixBytes > MAX_DESKTOP_NOTIFICATION_BODY_BYTES) break
    result += character
    bytes += characterBytes
  }
  return `${result.trimEnd()}${suffix}`
}
