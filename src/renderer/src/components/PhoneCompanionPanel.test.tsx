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
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  const render = (value: PhoneCompanion): void => {
    act(() => root.render(<PhoneCompanionPanel isOpen companion={value} onClose={() => {}} />))
  }

  it('draws the code and counts down to its expiry', () => {
    const value = companion()
    render(value)
    expect(value.refresh).toHaveBeenCalled()
    const svg = container.querySelector('svg[role="img"]')
    expect(svg?.getAttribute('shape-rendering')).toBe('crispEdges')
    // The white background and one rect for each dark run.
    expect(svg?.querySelectorAll('rect')).toHaveLength(3)
    expect(container.textContent).toContain('Code expires in 1:42')
    act(() => vi.advanceTimersByTime(2000))
    expect(container.textContent).toContain('Code expires in 1:40')
    expect(container.textContent).toContain('Same Wi-Fi only')
  })

  it('offers a new code in place of an expired one', () => {
    const value = companion()
    render(value)
    act(() => vi.advanceTimersByTime(103_000))
    expect(container.querySelector('svg[role="img"]')).toBeNull()
    expect(container.textContent).toContain('This code expired.')
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'New code'
    )
    act(() => button?.click())
    expect(value.newCode).toHaveBeenCalled()
  })

  it('waits for the answer on this computer instead of showing a code', () => {
    render(
      companion({
        status: status({ awaitingApproval: { name: 'iPhone', address: '192.168.1.57' } })
      })
    )
    expect(container.querySelector('svg[role="img"]')).toBeNull()
    expect(container.textContent).toContain('Waiting for you to allow iPhone (192.168.1.57)…')
    expect(container.textContent).toContain('Answer the prompt on this computer.')
  })

  it('shows no code while phone access is off', () => {
    const value = companion({ status: status({ enabled: false, pairing: null, address: null }) })
    render(value)
    expect(container.querySelector('svg[role="img"]')).toBeNull()
    const toggle = container.querySelector<HTMLInputElement>('input[aria-label="Phone access"]')
    expect(toggle?.checked).toBe(false)
    act(() => toggle?.click())
    expect(value.setEnabled).toHaveBeenCalledWith(true)
  })

  it('shows why phone access could not start', () => {
    render(companion({ status: status({ error: 'No Wi-Fi network', pairing: null }) }))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('No Wi-Fi network')
  })

  it('asks once before removing a phone, and forgets the question after 3 seconds', () => {
    const value = companion()
    render(value)
    const remove = (): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>('.phone-companion-device button')!
    expect(container.textContent).toContain('Connected now')
    act(() => remove().click())
    expect(remove().textContent).toBe('Remove?')
    expect(value.removeDevice).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(3000))
    expect(remove().textContent).toBe('Remove')
    act(() => remove().click())
    act(() => remove().click())
    expect(value.removeDevice).toHaveBeenCalledWith('phone-1')
  })

  it('says when there are no phones yet', () => {
    render(companion({ status: status({ devices: [] }) }))
    expect(container.textContent).toContain('No phones yet.')
  })
})
