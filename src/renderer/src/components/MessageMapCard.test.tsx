// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MapLinkLocation } from '../utils/mapLinks'
import { MessageMapCard } from './MessageMapCard'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./MessageMapPreview', () => ({
  default: ({ location }: { location: MapLinkLocation }) => (
    <div data-testid="map-preview">Preview for {location.label}</div>
  )
}))

const location: MapLinkLocation = {
  href: 'https://www.google.com/maps/search/?api=1&query=Bayfront%20Park%2C%20Miami',
  provider: 'google',
  providerLabel: 'Google Maps',
  label: 'Bayfront Park, Miami',
  query: 'Bayfront Park, Miami',
  zoom: 15,
  embedUrl: 'https://www.google.com/maps?q=Bayfront+Park%2C+Miami&z=15&output=embed'
}

describe('MessageMapCard', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.querySelectorAll('.message-map-dialog').forEach((node) => node.remove())
    container.remove()
  })

  it('shows one compact interactive map by default without intermediate size modes', async () => {
    await act(async () => root.render(<MessageMapCard location={location} />))
    expect(container.querySelector('[data-testid="map-preview"]')?.textContent).toContain(
      'Bayfront Park'
    )
    expect(container.querySelector('.message-map-surface')).not.toBeNull()
    expect(container.querySelector('.message-map-toggle')).toBeNull()
    expect(container.querySelector('button[aria-label="Make map taller"]')).toBeNull()
    const address = container.querySelector('.message-map-address') as HTMLAnchorElement
    expect(address.textContent).toBe('Bayfront Park, Miami')
    expect(address.target).toBe('_blank')
    expect(container.querySelector('.message-map-external')).toBeNull()
  })

  it('opens a large map and closes it with Escape', async () => {
    await act(async () => root.render(<MessageMapCard location={location} />))
    await act(async () =>
      (
        container.querySelector('button[aria-label="Open map full screen"]') as HTMLButtonElement
      ).click()
    )
    expect(document.querySelector('.message-map-dialog')).not.toBeNull()

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.querySelector('.message-map-dialog')).toBeNull()
  })
})
