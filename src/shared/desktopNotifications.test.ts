import { describe, expect, it } from 'vitest'
import {
  MAX_DESKTOP_NOTIFICATION_BODY_BYTES,
  normalizeDesktopNotificationBody
} from './desktopNotifications'

describe('normalizeDesktopNotificationBody', () => {
  it('normalizes whitespace and supplies a useful fallback', () => {
    expect(normalizeDesktopNotificationBody('  Finished\n\n successfully  ')).toBe(
      'Finished successfully'
    )
    expect(normalizeDesktopNotificationBody('')).toBe('Response completed.')
  })

  it('truncates by UTF-8 bytes without splitting emoji', () => {
    const result = normalizeDesktopNotificationBody('✅'.repeat(200))
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(
      MAX_DESKTOP_NOTIFICATION_BODY_BYTES
    )
    expect(result.endsWith('…')).toBe(true)
  })
})
