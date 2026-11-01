// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompanionStatus } from '../../../shared/companion'
import type { PhoneCompanion } from '../hooks/usePhoneCompanionStatus'
import PhoneCompanionPanel from './PhoneCompanionPanel'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.UTC(2026, 9, 23, 12)

function status(update: Partial<CompanionStatus> = {}): CompanionStatus {
  return {
    enabled: true,
    error: null,
    address: 'http://192.168.1.20:47615',
    pairing: {
      url: 'http://192.168.1.20:47615/#pair=abc',
      modules: [
        [true, false],
        [false, true]
      ],
      expiresAt: NOW + 102_000
    },
    awaitingApproval: null,
    devices: [
      {
        id: 'phone-1',
        name: 'Pixel 9',
        createdAt: NOW - 86_400_000,
        lastSeenAt: NOW,
        lastAddress: '192.168.1.42',
        connected: true
      }
    ],
    ...update
  }
}

function companion(update: Partial<PhoneCompanion> = {}): PhoneCompanion {
  return {
    status: status(),
    actionError: null,
    busy: false,
    refresh: vi.fn(),
    setEnabled: vi.fn(),
    newCode: vi.fn(),
    removeDevice: vi.fn(),
    ...update
  }
}

describe('PhoneCompanionPanel', () => {
  let container: HTMLDivElement
  let anchor: HTMLButtonElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    container = document.createElement('div')
    anchor = document.createElement('button')
    document.body.append(container, anchor)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    anchor.remove()
    vi.useRealTimers()
  })

  // The popover is drawn into the body, outside the container.
  const popover = (): HTMLElement | null => document.querySelector('.phone-popover')
  const countdown = (): string | null | undefined =>
    popover()?.querySelector('.phone-popover-countdown')?.textContent
  const button = (name: string): HTMLButtonElement | undefined =>
    [...(popover()?.querySelectorAll('button') ?? [])].find(
      (candidate) => candidate.getAttribute('aria-label') === name || candidate.textContent === name
    )

  const render = (value: PhoneCompanion, onClose: () => void = () => {}): void => {
    act(() =>
      root.render(
        <PhoneCompanionPanel
          isOpen
          companion={value}
          anchorRef={{ current: anchor }}
          placement="above"
          onClose={onClose}
        />
      )
    )
  }

  it('draws the code and counts down to its expiry', () => {
    const value = companion()
    render(value)
    expect(value.refresh).toHaveBeenCalled()
    expect(popover()?.querySelector('svg[role="img"]')).not.toBeNull()
    expect(countdown()).toBe('1:42')
    act(() => vi.advanceTimersByTime(2000))
    expect(countdown()).toBe('1:40')
  })

  it('fades an expired code under a button for a new one', () => {
    const value = companion()
    render(value)
    act(() => vi.advanceTimersByTime(103_000))
    expect(popover()?.querySelector('svg[role="img"]')).toBeNull()
    expect(countdown()).toBeUndefined()
    act(() => button('New code')?.click())
    expect(value.newCode).toHaveBeenCalled()
  })

  it('waits for the answer on this computer instead of showing a code', () => {
    render(
      companion({
        status: status({ awaitingApproval: { name: 'iPhone', address: '192.168.1.57' } })
      })
    )
    expect(popover()?.querySelector('svg[role="img"]')).toBeNull()
  })

  it('shows no code while phone access is off, and turns it on', () => {
    const value = companion({
      status: status({ enabled: false, pairing: null, address: null, devices: [] })
    })
    render(value)
    expect(popover()?.querySelector('svg[role="img"]')).toBeNull()
    const toggle = popover()?.querySelector<HTMLInputElement>('input[aria-label="Phone access"]')
    expect(toggle?.checked).toBe(false)
    act(() => toggle?.click())
    expect(value.setEnabled).toHaveBeenCalledWith(true)
  })

  it('asks once before removing a phone, and forgets the question after 3 seconds', () => {
    const value = companion()
    render(value)
    const remove = (): HTMLButtonElement =>
      popover()!.querySelector<HTMLButtonElement>('.phone-popover-device button')!
    act(() => remove().click())
    expect(value.removeDevice).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(3000))
    act(() => remove().click())
    expect(value.removeDevice).not.toHaveBeenCalled()
    act(() => remove().click())
    expect(value.removeDevice).toHaveBeenCalledWith('phone-1')
  })
})
