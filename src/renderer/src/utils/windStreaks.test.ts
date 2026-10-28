import { describe, expect, it } from 'vitest'
import { WindStreaks } from './windStreaks'

/** A repeatable stand-in for Math.random. */
function seeded(seed = 7): () => number {
  let value = seed
  return () => {
    value = (value * 16_807) % 2_147_483_647
    return value / 2_147_483_647
  }
}

function run(streaks: WindStreaks, seconds: number, wind: number): void {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) streaks.step(1 / 60, wind)
}

describe('wind streaks', () => {
  it('shows nothing in a breeze', () => {
    const streaks = new WindStreaks(seeded())
    run(streaks, 3, 0.2)
    expect(streaks.count()).toBe(0)
  })

  it('fades streaks in and out, and draws well-formed strokes', () => {
    const streaks = new WindStreaks(seeded())
    for (let i = 0; i < 90; i += 1) {
      streaks.step(1 / 60, 1)
      for (const { d, opacity } of streaks.paths()) {
        expect(d).toMatch(/^M-?\d/)
        expect(d).not.toMatch(/NaN|Infinity/)
        expect(opacity).toBeGreaterThanOrEqual(0)
        expect(opacity).toBeLessThanOrEqual(0.85)
      }
    }
  })
})
