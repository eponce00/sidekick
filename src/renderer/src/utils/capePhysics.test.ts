import { describe, expect, it } from 'vitest'
import {
  CAPE_REST_ANGLE,
  arrivingCape,
  capePose,
  capeSettled,
  gust,
  pointerWind,
  stepCape,
  whip,
  type CapeState
} from './capePhysics'

function run(state: CapeState, seconds: number): CapeState[] {
  const frames = [state]
  for (let i = 0; i < Math.round(seconds * 60); i += 1)
    frames.push(stepCape(frames.at(-1)!, 1 / 60))
  return frames
}

const still: CapeState = { angle: CAPE_REST_ANGLE, velocity: 0, wind: 0, time: 0 }

describe('cape physics', () => {
  it('arrives lifted, swings past its rest, and settles where gravity leaves it', () => {
    const frames = run(arrivingCape(), 8)
    expect(frames[0].angle).toBeGreaterThan(CAPE_REST_ANGLE + 10)
    // Underdamped: it drops below rest before it settles, as cloth swings.
    expect(Math.min(...frames.map((f) => f.angle))).toBeLessThan(CAPE_REST_ANGLE)
    expect(capeSettled(frames.at(-1)!)).toBe(true)
  })

  it('stays still in still air', () => {
    expect(capeSettled(still)).toBe(true)
    expect(capePose(still)).toEqual({ angle: CAPE_REST_ANGLE, stretch: 1, skew: 0 })
  })

  it('lifts in a gust and comes back down when it dies away', () => {
    const frames = run(gust(still, 1), 6)
    const highest = Math.max(...frames.map((f) => f.angle))
    expect(highest).toBeGreaterThan(CAPE_REST_ANGLE + 8)
    expect(capeSettled(frames.at(-1)!)).toBe(true)
  })

  it('flutters only while the wind blows', () => {
    const blowing = { ...still, wind: 0.8, time: 0.3 }
    expect(capePose(blowing).skew).not.toBe(0)
    expect(capePose(blowing).stretch).toBeGreaterThan(1)
  })

  it('a weaker gust does not calm a stronger one', () => {
    expect(gust({ ...still, wind: 0.9 }, 0.3).wind).toBe(0.9)
    expect(gust(still, 7).wind).toBe(1)
  })

  it('flicks up at once when clicked', () => {
    const frames = run(whip(still), 0.25)
    expect(frames.at(-1)!.angle).toBeGreaterThan(CAPE_REST_ANGLE + 10)
  })

  it('treats a slow pointer as still air and a quick sweep as a gust', () => {
    expect(pointerWind(0.2)).toBe(0)
    expect(pointerWind(1.2)).toBeGreaterThan(0.3)
    expect(pointerWind(10)).toBe(1)
  })
})
