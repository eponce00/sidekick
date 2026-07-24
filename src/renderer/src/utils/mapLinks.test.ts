import { describe, expect, it } from 'vitest'
import { parseMapLink } from './mapLinks'

describe('mapLinks', () => {
  it('extracts coordinates, zoom, and place name from full Google Maps links', () => {
    const result = parseMapLink(
      'https://www.google.com/maps/place/Buttermilk+Bakery/@28.5990,-81.3392,17z/data=x',
      'Google Maps'
    )
    expect(result).toMatchObject({
      provider: 'google',
      providerLabel: 'Google Maps',
      label: 'Buttermilk Bakery',
      query: 'Buttermilk Bakery',
      coordinates: { latitude: 28.599, longitude: -81.3392 },
      zoom: 17
    })
    expect(result?.embedUrl).toContain('q=28.599%2C-81.3392')
  })

  it('supports API-style Google search links without coordinates', () => {
    const result = parseMapLink(
      'https://www.google.com/maps/search/?api=1&query=Chiffon+Culture+Bakery+Orlando',
      'Open in Google Maps'
    )
    expect(result).toMatchObject({
      provider: 'google',
      label: 'Chiffon Culture Bakery Orlando',
      query: 'Chiffon Culture Bakery Orlando'
    })
    expect(result?.embedUrl).toContain('q=Chiffon+Culture+Bakery+Orlando')
  })

  it('extracts coordinate-bearing Apple Maps and OpenStreetMap links', () => {
    expect(
      parseMapLink('https://maps.apple.com/?q=Bakery&ll=28.5,-81.4', 'Apple Maps')
    ).toMatchObject({
      provider: 'apple',
      label: 'Bakery',
      coordinates: { latitude: 28.5, longitude: -81.4 }
    })
    expect(
      parseMapLink('https://www.openstreetmap.org/#map=16/28.5/-81.4', 'OpenStreetMap')
    ).toMatchObject({
      provider: 'openstreetmap',
      zoom: 16,
      coordinates: { latitude: 28.5, longitude: -81.4 }
    })
  })

  it('rejects unrelated and unsafe URLs', () => {
    expect(parseMapLink('https://example.com/map', 'Map')).toBeNull()
    expect(parseMapLink('javascript:alert(1)', 'Map')).toBeNull()
    expect(parseMapLink('not a url', 'Map')).toBeNull()
  })
})
