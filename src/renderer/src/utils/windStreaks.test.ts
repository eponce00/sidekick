import { describe, expect, it } from 'vitest'
import { MAX_STREAKS, WindStreaks } from './windStreaks'

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

  it('sweeps streaks past in a gust, more the stronger it blows', () => {
    const light = new WindStreaks(seeded())
    const strong = new WindStreaks(seeded())
    let lightSeen = 0
    let strongSeen = 0
    for (let i = 0; i < 120; i += 1) {
      light.step(1 / 60, 0.4)
      strong.step(1 / 60, 1)
      lightSeen += light.count()
      strongSeen += strong.count()
    }
    expect(lightSeen).toBeGreaterThan(0)
    expect(strongSeen).toBeGreaterThan(lightSeen)
    expect(strong.count()).toBeLessThanOrEqual(MAX_STREAKS)
  })

  it('moves each streak across and away, then lets it go once the wind drops', () => {
    const streaks = new WindStreaks(seeded())
    run(streaks, 0.2, 1)
    const startX = Number(/^M(-?[\d.]+)/.exec(streaks.paths()[0].d)![1])
    run(streaks, 0.1, 1)
    const laterX = Number(/^M(-?[\d.]+)/.exec(streaks.paths()[0].d)![1])
    expect(laterX).toBeLessThan(startX)
    run(streaks, 2, 0)
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

  it('marks the start of a gust with a burst of streaks', () => {
    const streaks = new WindStreaks(seeded())
    streaks.burst(3)
    expect(streaks.count()).toBe(3)
    // Spread out along their way rather than drawn on top of one another.
    expect(new Set(streaks.paths().map(({ d }) => d)).size).toBe(3)
  })
})
