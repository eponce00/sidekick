import type { ProviderInstanceHealth } from './settings'

export const PROVIDER_HEALTH_STALE_AFTER_MS = 10 * 60 * 1000

export type ProviderHealthDisplayState = 'unknown' | 'online' | 'offline' | 'stale'

export interface ProviderHealthDisplay {
  state: ProviderHealthDisplayState
  label: string
  detail: string
}

function safeHealthMessage(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:api[-_ ]?key|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

export function providerHealthErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'Connection failed')
  return safeHealthMessage(message) || 'Connection failed'
}

export function onlineProviderHealth(
  checkedAt = Date.now(),
  discoveredModelCount?: number
): ProviderInstanceHealth {
  return {
    status: 'online',
    checkedAt,
    ...(discoveredModelCount === undefined ? {} : { discoveredModelCount })
  }
}

export function offlineProviderHealth(
  error: unknown,
  checkedAt = Date.now()
): ProviderInstanceHealth {
  return {
    status: 'offline',
    checkedAt,
    message: providerHealthErrorMessage(error)
  }
}

export function unknownProviderHealth(): ProviderInstanceHealth {
  return { status: 'unknown' }
}

function relativeCheckedTime(checkedAt: number, now: number): string {
  const elapsed = Math.max(0, now - checkedAt)
  if (elapsed < 60_000) return 'just now'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function describeProviderHealth(
  health: ProviderInstanceHealth | undefined,
  now = Date.now()
): ProviderHealthDisplay {
  if (!health || health.status === 'unknown' || !health.checkedAt) {
    return { state: 'unknown', label: 'Not checked', detail: 'Connection has not been checked' }
  }

  const checked = relativeCheckedTime(health.checkedAt, now)
  if (now - health.checkedAt >= PROVIDER_HEALTH_STALE_AFTER_MS) {
    const lastResult = health.status === 'online' ? 'online' : 'offline'
    return {
      state: 'stale',
      label: 'Status stale',
      detail: `Last checked ${checked}; last result was ${lastResult}`
    }
  }

  if (health.status === 'online') {
    return { state: 'online', label: 'Online', detail: `Checked ${checked}` }
  }

  return {
    state: 'offline',
    label: 'Offline',
    detail: health.message ? `${health.message} · checked ${checked}` : `Checked ${checked}`
  }
}

/**
 * Compact availability for chat surfaces.
 *
 * A stale timestamp means the diagnostic probe is old; it does not mean a
 * provider that was last confirmed online is degraded. Settings can surface
 * that age as a warning, while composers should communicate the last known
 * availability without turning a working model yellow.
 */
export function describeProviderAvailability(
  health: ProviderInstanceHealth | undefined,
  now = Date.now()
): ProviderHealthDisplay {
  const diagnostic = describeProviderHealth(health, now)
  if (diagnostic.state !== 'stale') return diagnostic

  if (health?.status === 'online') {
    return {
      state: 'online',
      label: 'Last known online',
      detail: diagnostic.detail
    }
  }

  return {
    state: 'unknown',
    label: 'Status unknown',
    detail: diagnostic.detail
  }
}
