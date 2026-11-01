import { describe, expect, it } from 'vitest'
import { CapeCloth } from './capeCloth'

function run(cloth: CapeCloth, seconds: number, wind = 0, frame = 1 / 60): void {
  for (let t = 0; t < seconds - 1e-9; t += frame) cloth.step(frame, wind)
}

describe('cape cloth', () => {
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
