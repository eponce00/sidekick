import { describe, expect, it } from 'vitest'
import { nextScheduleOccurrence, validateScheduleInput, type ScheduleTiming } from './schedules'

// Local wall-clock instants, so the expectations hold in any time zone the suite runs in.
const at = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number =>
  new Date(year, month - 1, day, hour, minute, second).getTime()

const timing = (overrides: Partial<ScheduleTiming>): ScheduleTiming => ({
  cadence: 'daily',
  hour: 9,
  minute: 0,
  weekday: 1,
  ...overrides
})

describe('nextScheduleOccurrence', () => {
  it('runs hourly at the chosen minute', () => {
    const hourly = timing({ cadence: 'hourly', minute: 15 })
    expect(nextScheduleOccurrence(hourly, at(2026, 10, 16, 10, 5))).toBe(at(2026, 10, 16, 10, 15))
    expect(nextScheduleOccurrence(hourly, at(2026, 10, 16, 10, 15))).toBe(at(2026, 10, 16, 11, 15))
    expect(nextScheduleOccurrence(hourly, at(2026, 10, 16, 23, 30))).toBe(at(2026, 10, 17, 0, 15))
  })

  it('runs hourly in the hour repeated when the clocks go back', () => {
    // Built from wall-clock hours, 1:30 resolved to its first occurrence both times, skipping one.
    const zone = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const firstOneThirty = Date.UTC(2026, 10, 1, 5, 30)
      expect(new Date(firstOneThirty).getHours()).toBe(1)
      const hourly = timing({ cadence: 'hourly', minute: 30 })
      expect(nextScheduleOccurrence(hourly, firstOneThirty)).toBe(Date.UTC(2026, 10, 1, 6, 30))
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })

  it('is strictly after the given instant, so a run that just started is not due again', () => {
    const daily = timing({ hour: 9, minute: 0 })
    expect(nextScheduleOccurrence(daily, at(2026, 10, 16, 9, 0))).toBe(at(2026, 10, 17, 9, 0))
    expect(nextScheduleOccurrence(daily, at(2026, 10, 16, 8, 59, 59))).toBe(at(2026, 10, 16, 9, 0))
  })

  it('crosses month and year boundaries', () => {
    const daily = timing({ hour: 7, minute: 30 })
    expect(nextScheduleOccurrence(daily, at(2026, 12, 31, 8))).toBe(at(2027, 1, 1, 7, 30))
  })

  it('skips weekends for weekday schedules', () => {
    const weekdays = timing({ cadence: 'weekdays', hour: 9 })
    // 2026-10-16 is a Friday.
    expect(new Date(at(2026, 10, 16)).getDay()).toBe(5)
    expect(nextScheduleOccurrence(weekdays, at(2026, 10, 16, 10))).toBe(at(2026, 10, 19, 9))
    expect(nextScheduleOccurrence(weekdays, at(2026, 10, 17, 12))).toBe(at(2026, 10, 19, 9))
    expect(nextScheduleOccurrence(weekdays, at(2026, 10, 19, 8))).toBe(at(2026, 10, 19, 9))
  })

  it('runs weekly on the chosen day', () => {
    const wednesdays = timing({ cadence: 'weekly', weekday: 3, hour: 18, minute: 45 })
    expect(nextScheduleOccurrence(wednesdays, at(2026, 10, 16, 10))).toBe(at(2026, 10, 21, 18, 45))
    expect(nextScheduleOccurrence(wednesdays, at(2026, 10, 21, 18, 45))).toBe(
      at(2026, 10, 28, 18, 45)
    )
  })

  it('keeps a daily run at its wall-clock time across a month of days', () => {
    const daily = timing({ hour: 6, minute: 5 })
    let cursor = at(2026, 3, 1)
    for (let day = 1; day <= 31; day += 1) {
      cursor = nextScheduleOccurrence(daily, cursor)
      const date = new Date(cursor)
      expect([date.getDate(), date.getHours(), date.getMinutes()]).toEqual([day, 6, 5])
    }
  })
})

describe('validateScheduleInput', () => {
  const valid = {
    name: '  Morning check ',
    prompt: 'Summarize yesterday.',
    projectId: 'project-1',
    modelId: 'ollama:local/qwen',
    cadence: 'weekdays',
    hour: 9,
    minute: 0,
    weekday: 1,
    catchUp: true
  }

  it('trims and keeps a valid schedule', () => {
    // A new chat for each run unless the schedule says to continue.
    expect(validateScheduleInput(valid)).toEqual({
      ...valid,
      name: 'Morning check',
      chatMode: 'new'
    })
    expect(validateScheduleInput({ ...valid, chatMode: 'continue' }).chatMode).toBe('continue')
    expect(validateScheduleInput({ ...valid, projectId: null }).projectId).toBeNull()
  })

  it('rejects malformed input from the renderer', () => {
    for (const input of [
      null,
      { ...valid, name: ' ' },
      { ...valid, prompt: '' },
      { ...valid, cadence: 'every-minute' },
      { ...valid, hour: 24 },
      { ...valid, minute: 1.5 },
      { ...valid, weekday: 7 },
      { ...valid, modelId: '' },
      { ...valid, projectId: 42 },
      { ...valid, prompt: 'x'.repeat(20_001) },
      { ...valid, chatMode: 'forever' }
    ]) {
      expect(() => validateScheduleInput(input)).toThrow()
    }
  })
})
