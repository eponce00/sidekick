import { describe, expect, it } from 'vitest'
import {
  PROVIDER_HEALTH_STALE_AFTER_MS,
  describeProviderAvailability,
  describeProviderHealth,
  offlineProviderHealth,
  onlineProviderHealth,
  providerHealthErrorMessage,
  unknownProviderHealth
} from './providerHealth'

describe('provider health', () => {
  const now = 1_000_000

  it('treats a missing durable result as unknown', () => {
    expect(unknownProviderHealth()).toEqual({ status: 'unknown' })
    expect(describeProviderHealth(undefined, now)).toMatchObject({
      state: 'unknown',
      label: 'Not checked'
    })
  })

  it('reports a recent successful check as online', () => {
    expect(describeProviderHealth(onlineProviderHealth(now - 30_000, 3), now)).toEqual({
      state: 'online',
      label: 'Online',
      detail: 'Checked just now'
    })
  })

  it('derives stale state instead of persisting it', () => {
    expect(
      describeProviderHealth(onlineProviderHealth(now - PROVIDER_HEALTH_STALE_AFTER_MS), now)
    ).toMatchObject({ state: 'stale', label: 'Status stale' })
  })

  it('keeps a stale successful check green on compact chat surfaces', () => {
    const health = onlineProviderHealth(now - PROVIDER_HEALTH_STALE_AFTER_MS)

    expect(describeProviderAvailability(health, now)).toMatchObject({
      state: 'online',
      label: 'Last known online'
    })
    expect(describeProviderHealth(health, now)).toMatchObject({ state: 'stale' })
  })

  it('does not present an old failed check as a current outage', () => {
    const health = offlineProviderHealth(
      new Error('Connection refused'),
      now - PROVIDER_HEALTH_STALE_AFTER_MS
    )

    expect(describeProviderAvailability(health, now)).toMatchObject({
      state: 'unknown',
      label: 'Status unknown'
    })
  })

  it('stores a bounded, redacted failure message', () => {
    const message = providerHealthErrorMessage(
      new Error(`Authorization: Bearer secret-token api_key=also-secret ${'x'.repeat(300)}`)
    )
    expect(message).not.toContain('secret-token')
    expect(message).not.toContain('also-secret')
    expect(message.length).toBeLessThanOrEqual(240)
    expect(offlineProviderHealth(new Error('Connection refused'), now)).toEqual({
      status: 'offline',
      checkedAt: now,
      message: 'Connection refused'
    })
  })
})
