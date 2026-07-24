import { describe, expect, it } from 'vitest'
import { shouldOfferModelSearch } from './modelPickerDensity'

describe('chat model picker density', () => {
  it('keeps search hidden for the five-row compact list', () => {
    expect(shouldOfferModelSearch(0)).toBe(false)
    expect(shouldOfferModelSearch(5)).toBe(false)
  })

  it('offers opt-in search when the pinned list needs scrolling', () => {
    expect(shouldOfferModelSearch(6)).toBe(true)
    expect(shouldOfferModelSearch(24)).toBe(true)
  })
})
