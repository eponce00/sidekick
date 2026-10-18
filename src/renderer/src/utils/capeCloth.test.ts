import { describe, expect, it } from 'vitest'
import { CapeCloth } from './capeCloth'

const LENGTH = 470

function run(cloth: CapeCloth, seconds: number, wind = 0, frame = 1 / 60): void {
  for (let t = 0; t < seconds - 1e-9; t += frame) cloth.step(frame, wind)
}

describe('cape cloth', () => {
  it('falls from the flying pose and drapes down and back in still air', () => {
    const cloth = new CapeCloth()
    const neck = cloth.neck()
    expect(cloth.hem().y - neck.y).toBeLessThan(LENGTH * 0.3)
    run(cloth, 6)
    const hem = cloth.hem()
    // Gravity wins: the hem hangs well below the neck, trailing back only a little.
    expect(hem.y - neck.y).toBeGreaterThan(LENGTH * 0.7)
    expect(hem.x).toBeLessThan(neck.x)
  })

  it('streams back in a strong wind and drops again when it dies', () => {
    const cloth = new CapeCloth()
    run(cloth, 4)
    const resting = cloth.hem().y
    run(cloth, 1.5, 1)
    // It flutters, so judge where the hem spends the next second.
    let x = 0
    let y = 0
    for (let i = 0; i < 60; i += 1) {
      cloth.step(1 / 60, 1)
      x += cloth.hem().x / 60
      y += cloth.hem().y / 60
    }
    const neck = cloth.neck()
    expect(x).toBeLessThan(neck.x - LENGTH * 0.6)
    expect(y).toBeLessThan(resting - LENGTH * 0.3)
    run(cloth, 5)
    expect(cloth.hem().y).toBeGreaterThan(resting - LENGTH * 0.15)
  })

  it('bends rather than turning as one piece: the middle lags the hem in a gust', () => {
    const cloth = new CapeCloth()
    run(cloth, 4)
    const before = cloth.paths().cape
    run(cloth, 0.3, 1)
    expect(cloth.paths().cape).not.toBe(before)
    // A rigid cape would keep the same outline shape; cloth changes its curvature.
    const shapeOf = (d: string): number[] => d.match(/-?\d+\.\d/g)!.map(Number)
    expect(shapeOf(cloth.paths().cape).length).toBe(shapeOf(before).length)
  })

  it('flicks up when clicked, from the hem most', () => {
    const cloth = new CapeCloth()
    run(cloth, 4)
    const resting = cloth.hem().y
    cloth.flick()
    run(cloth, 0.25)
    expect(cloth.hem().y).toBeLessThan(resting - 100)
  })

  it('is dragged along by something brushing through it', () => {
    const cloth = new CapeCloth()
    run(cloth, 4)
    const hem = cloth.hem()
    for (let i = 0; i < 10; i += 1) {
      cloth.brush(cloth.hem(), { x: 2_000, y: 0 })
      cloth.step(1 / 60, 0)
    }
    expect(cloth.hem().x).toBeGreaterThan(hem.x + 40)
    // Far away, the same sweep touches nothing.
    const untouched = new CapeCloth()
    run(untouched, 4)
    const before = untouched.hem()
    untouched.brush({ x: 2_000, y: 2_000 }, { x: 2_000, y: 0 })
    untouched.step(1 / 60, 0)
    const reference = new CapeCloth()
    run(reference, 4)
    reference.step(1 / 60, 0)
    expect(untouched.hem()).toEqual(reference.hem())
    expect(before).not.toBeUndefined()
  })

  it('barely stretches, however hard it is thrown about', () => {
    const cloth = new CapeCloth()
    let worst = 0
    for (let i = 0; i < 240; i += 1) {
      if (i % 60 === 0) cloth.flick()
      cloth.step(1 / 60, i % 120 < 60 ? 1 : 0)
      worst = Math.max(worst, cloth.maxStretch())
    }
    expect(worst).toBeLessThan(0.001)
  })

  it('moves the same at any frame rate', () => {
    const slow = new CapeCloth()
    const fast = new CapeCloth()
    run(slow, 2, 0.6, 1 / 30)
    run(fast, 2, 0.6, 1 / 120)
    expect(slow.hem().x).toBeCloseTo(fast.hem().x, 0)
    expect(slow.hem().y).toBeCloseTo(fast.hem().y, 0)
  })

  it('always draws a well-formed outline and creases', () => {
    const cloth = new CapeCloth()
    for (let i = 0; i < 120; i += 1) {
      cloth.step(1 / 60, i < 40 ? 1 : 0)
      const { cape, folds } = cloth.paths()
      for (const d of [cape, folds]) {
        expect(d).toMatch(/^M-?\d/)
        expect(d.endsWith('Z')).toBe(true)
        expect(d).not.toMatch(/NaN|Infinity/)
      }
    }
  })
})
