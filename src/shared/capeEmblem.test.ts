import { describe, expect, it } from 'vitest'
import { capeEmblemPaths } from './capeEmblem'

const hanging = (position: number) => ({ x: 0, y: position * 470, tx: 0, ty: 1 })
const coordinates = (d: string): number[] => d.match(/-?\d+(?:\.\d+)?/g)!.map(Number)

describe('printed cape emblem', () => {
  it('centres the large shield on the body of the cloth, away from the neck and hem', () => {
    const points = coordinates(capeEmblemPaths(hanging).shield)
    const xs = points.filter((_, index) => index % 2 === 0)
    const ys = points.filter((_, index) => index % 2 === 1)
    expect(Math.min(...xs)).toBeGreaterThan(-80)
    expect(Math.max(...xs)).toBeLessThan(80)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(110)
    expect(Math.min(...ys)).toBeGreaterThan(180)
    expect(Math.max(...ys)).toBeLessThan(360)
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(470 * 0.58, -1)
  })

  it('keeps the prompt and cursor disconnected while following the same fabric surface', () => {
    const original = capeEmblemPaths(hanging)
    const shifted = capeEmblemPaths((position) => ({
      ...hanging(position),
      x: 100,
      y: position * 470 + 200
    }))
    expect(original.mark.match(/M/g)).toHaveLength(2)
    for (const key of ['shield', 'mark'] as const) {
      const before = coordinates(original[key])
      const after = coordinates(shifted[key])
      expect(after).toHaveLength(before.length)
      after.forEach((coordinate, index) => {
        expect(coordinate - before[index]).toBeCloseTo(index % 2 === 0 ? 100 : 200, 1)
      })
    }
  })
})
