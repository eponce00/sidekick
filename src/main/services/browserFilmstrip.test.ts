import { describe, expect, it, vi } from 'vitest'
import { composeBitmapsSideBySide } from './browserFilmstrip'

vi.mock('electron', () => ({ nativeImage: {} }))

const solid = (width: number, height: number, value: number): Buffer =>
  Buffer.alloc(width * height * 4, value)

describe('composeBitmapsSideBySide', () => {
  it('places frames left to right in order with a grey gap between them', () => {
    const strip = composeBitmapsSideBySide(
      [
        { data: solid(2, 2, 0x11), width: 2, height: 2 },
        { data: solid(2, 2, 0x22), width: 2, height: 2 }
      ],
      1
    )
    expect(strip).toMatchObject({ width: 5, height: 2 })
    const pixel = (x: number, y: number): number[] => [
      ...strip.data.subarray((y * 5 + x) * 4, (y * 5 + x) * 4 + 4)
    ]
    expect(pixel(1, 1)).toEqual([0x11, 0x11, 0x11, 0x11])
    expect(pixel(2, 0)).toEqual([0x40, 0x40, 0x40, 0xff])
    expect(pixel(3, 1)).toEqual([0x22, 0x22, 0x22, 0x22])
  })
})
