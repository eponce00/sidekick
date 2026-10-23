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
  const text = (): string => popover()?.textContent ?? ''
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
    const svg = popover()?.querySelector('svg[role="img"]')
    expect(svg?.getAttribute('shape-rendering')).toBe('crispEdges')
    // The white background and one rect for each dark run.
    expect(svg?.querySelectorAll('rect')).toHaveLength(3)
    expect(text()).toContain('Scan with your phone’s camera')
    expect(countdown()).toBe('1:42')
    act(() => vi.advanceTimersByTime(2000))
    expect(countdown()).toBe('1:40')
    act(() => button('New code')?.click())
    expect(value.newCode).toHaveBeenCalledTimes(1)
  })

  it('keeps the safety note and the address in the footer’s help', () => {
    render(companion())
    const footer = popover()?.querySelector('.phone-popover-footer')
    expect(footer?.textContent).toContain('Only on Wi-Fi you trust.')
    expect(footer?.getAttribute('title')).toContain('Turn this on only on Wi-Fi you trust')
    expect(footer?.getAttribute('title')).toContain('http://192.168.1.20:47615')
  })

  it('fades an expired code under a button for a new one', () => {
    const value = companion()
    render(value)
    act(() => vi.advanceTimersByTime(103_000))
    expect(popover()?.querySelector('svg[role="img"]')).toBeNull()
    expect(popover()?.querySelector('.phone-popover-qr.is-expired svg')).not.toBeNull()
    expect(text()).toContain('This code expired')
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
    expect(popover()?.querySelector('[role="status"]')?.textContent).toBe(
      'Allow “iPhone” on this computer'
    )
  })

  it('shows one line and no code while phone access is off', () => {
    const value = companion({
      status: status({ enabled: false, pairing: null, address: null, devices: [] })
    })
    render(value)
    expect(popover()?.querySelector('svg[role="img"]')).toBeNull()
    expect(text()).toContain('Open your chats on a phone on this Wi-Fi.')
    expect(popover()?.querySelector('.phone-popover-devices')).toBeNull()
    const toggle = popover()?.querySelector<HTMLInputElement>('input[aria-label="Phone access"]')
    expect(toggle?.checked).toBe(false)
    act(() => toggle?.click())
    expect(value.setEnabled).toHaveBeenCalledWith(true)
  })

  it('shows why phone access could not start', () => {
    render(companion({ status: status({ enabled: false, error: 'No Wi-Fi network' }) }))
    expect(popover()?.querySelector('[role="alert"]')?.textContent).toBe('No Wi-Fi network')
    expect(text()).not.toContain('Open your chats on a phone')
    expect(popover()?.querySelector('svg[role="img"]')).toBeNull()
  })

  it('lists paired phones with whether they are connected', () => {
    const [device] = status().devices
    const iPhone = {
      ...device,
      id: 'phone-2',
      name: 'iPhone',
      connected: false,
      lastSeenAt: NOW - 7_200_000
    }
    render(companion({ status: status({ devices: [device, iPhone] }) }))
    const rows = [...(popover()?.querySelectorAll('.phone-popover-device') ?? [])]
    expect(rows.map((row) => row.textContent)).toEqual(['Pixel 9Connected', 'iPhone2 h ago'])
    expect(rows[0].querySelector('.phone-popover-device-dot')).not.toBeNull()
    expect(rows[1].querySelector('.phone-popover-device-dot')).toBeNull()
  })

  it('asks once before removing a phone, and forgets the question after 3 seconds', () => {
    const value = companion()
    render(value)
    const remove = (): HTMLButtonElement =>
      popover()!.querySelector<HTMLButtonElement>('.phone-popover-device button')!
    expect(remove().getAttribute('aria-label')).toBe('Remove Pixel 9')
    act(() => remove().click())
    expect(remove().textContent).toBe('Remove')
    expect(remove().getAttribute('aria-label')).toBe('Confirm removing Pixel 9')
    expect(value.removeDevice).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(3000))
    expect(remove().getAttribute('aria-label')).toBe('Remove Pixel 9')
    act(() => remove().click())
    act(() => remove().click())
    expect(value.removeDevice).toHaveBeenCalledWith('phone-1')
  })

  it('shows no phone list when none are paired', () => {
    render(companion({ status: status({ devices: [] }) }))
    expect(popover()?.querySelector('.phone-popover-devices')).toBeNull()
  })

  it('closes on Escape and on a click outside, but not on its own button', () => {
    const onClose = vi.fn()
    render(companion(), onClose)
    act(() => {
      anchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      popover()?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('returns focus to its button when it closes', () => {
    anchor.focus()
    render(companion())
    act(() => vi.runOnlyPendingTimers())
    expect(document.activeElement).not.toBe(anchor)
    act(() => root.render(<></>))
    expect(document.activeElement).toBe(anchor)
  })
})
