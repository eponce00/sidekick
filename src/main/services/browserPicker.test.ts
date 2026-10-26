import { describe, expect, it } from 'vitest'
import { rankChoices } from './browserPicker'
import { busyRequests } from './browserSettle'
import { fieldDateFormat, formatDate, sameEnteredText } from './browserDates'

const choice = (name: string, value = ''): Parameters<typeof rankChoices>[0][number] => ({
  names: [name],
  value,
  disabled: false,
  key: name + value
})

describe('browser controls', () => {
  it('picks the exact option and refuses to guess between two', () => {
    const rooms = [choice('Deluxe King', 'dlx'), choice('Deluxe King, ocean view', 'dlx-view')]
    expect(rankChoices(rooms, ['deluxe king'])).toMatchObject({ status: 'picked', index: 0 })
    expect(rankChoices(rooms, ['Deluxe'])).toMatchObject({ status: 'ambiguous', indexes: [0, 1] })
    expect(rankChoices(rooms, ['Suite'])).toEqual({ status: 'missing' })
  })

  it('lets a request open before the action stop holding the page busy', () => {
    const longPoll = { resourceType: 'Fetch', startedAt: 0 }
    expect(busyRequests([longPoll], 10_000, 10_100)).toBe(0)
    expect(busyRequests([{ resourceType: 'Fetch', startedAt: 10_050 }], 10_000, 10_100)).toBe(1)
    expect(busyRequests([{ resourceType: 'Image', startedAt: 10_050 }], 10_000, 10_100)).toBe(0)
  })

  it('writes an ISO date in the format a text box asks for', () => {
    const format = fieldDateFormat('MM/DD/YYYY')!
    expect(formatDate('2026-11-16', format)).toBe('11/16/2026')
    expect(formatDate('2026-02-30', format)).toBeUndefined()
    expect(fieldDateFormat('Search cities')).toBeUndefined()
    expect(sameEnteredText('11/16/2026', '11162026')).toBe(true)
    expect(sameEnteredText('20/26/1116', '11/16/2026')).toBe(false)
  })
})
